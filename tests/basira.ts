import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Basira } from "../target/types/basira";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";

// ── helpers ───────────────────────────────────────────────────────────────────

const SOL = LAMPORTS_PER_SOL;

function agentPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
    programId
  );
}

function policyPda(agent: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), agent.toBuffer()],
    programId
  );
}

function vaultPda(agent: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agent.toBuffer()],
    programId
  );
}

function seqBuf(seq: BN): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(seq.toString()));
  return buf;
}

function intentPda(agent: PublicKey, seq: BN, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

function receiptPda(agent: PublicKey, seq: BN, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

// Anchor encodes enums as objects with a single key.
const Action = {
  transfer:     { transfer: {} },
  swap:         { swap: {} },
  stake:        { stake: {} },
  contractCall: { contractCall: {} },
};

// Allowed-actions bitmask: bit 0 = Transfer, 1 = Swap, 2 = Stake, 3 = ContractCall.
function maskFor(...actions: number[]): number {
  return actions.reduce((acc, bit) => acc | (1 << bit), 0);
}

// Rule constructors — Anchor enum-variant shape.
const Rule = {
  maxValue: (lamports: BN | number) => ({ maxValue: { lamports: new BN(lamports) } }),
  allowedActions: (mask: number) => ({ allowedActions: { mask } }),
  ratePerWindow: (windowSeconds: BN | number, max: number) => ({
    ratePerWindow: { windowSeconds: new BN(windowSeconds), max },
  }),
};

async function airdrop(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  sol: number
) {
  const sig = await provider.connection.requestAirdrop(to, sol * SOL);
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...bh });
}

async function fundVault(
  provider: anchor.AnchorProvider,
  vault: PublicKey,
  sol: number
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: vault,
      lamports: sol * SOL,
    })
  );
  await provider.sendAndConfirm(tx);
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("basira", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Basira as Program<Basira>;
  const provider = program.provider as anchor.AnchorProvider;
  const authority = provider.wallet.publicKey;

  const ALLOWED_MASK = maskFor(0, 1); // Transfer + Swap
  const [agentPubkey] = agentPda(authority, program.programId);
  const [vaultPubkey] = vaultPda(agentPubkey, program.programId);
  const [policyPubkey] = policyPda(agentPubkey, program.programId);

  // 3-rule policy: max 5 SOL · only Transfer+Swap · rate 3/60s.
  const defaultRules = [
    Rule.maxValue(new BN(5 * SOL)),
    Rule.allowedActions(ALLOWED_MASK),
    Rule.ratePerWindow(new BN(60), 3),
  ];

  // ── 1. Registration ────────────────────────────────────────────────────────

  it("registers an agent with a 3-rule policy", async () => {
    await program.methods
      .registerAgent("demo-agent", defaultRules as any, null)
      .accounts({ authority })
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPubkey);
    assert.equal(agent.name, "demo-agent");
    assert.equal(agent.intentCount.toNumber(), 0);
    assert.ok(agent.policyAuthority.equals(authority), "policy_authority defaults to authority");

    const policy = await program.account.policyAccount.fetch(policyPubkey);
    assert.equal(policy.version, 0);
    assert.equal(policy.rules.length, 3);
    assert.ok(policy.agent.equals(agentPubkey));

    // The RatePerWindow rule sits at index 2; counter slot 0 should point at it.
    const slot = agent.windows.find((w: any) => w.active);
    assert.ok(slot, "rate window counter should be initialized");
    assert.equal(slot.ruleIndex, 2);
    assert.equal(slot.count, 0);

    console.log(`  ✓ agent ${agentPubkey.toBase58()}`);
    console.log(`  ✓ policy ${policyPubkey.toBase58()} (v0, 3 rules)`);
  });

  // ── 2. In-policy Transfer → real CPI ──────────────────────────────────────

  it("approves and executes a transfer that actually moves SOL via CPI", async () => {
    const recipient = Keypair.generate().publicKey;
    const seq = new BN(0);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);

    await fundVault(provider, vaultPubkey, 2);
    const vaultBefore = await provider.connection.getBalance(vaultPubkey);
    const recipientBefore = await provider.connection.getBalance(recipient);
    assert.equal(recipientBefore, 0);

    await program.methods
      .submitIntent(Action.transfer, new BN(1 * SOL), recipient)
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { approved: {} });
    assert.isNull(intent.rejectionReason);

    await program.methods
      .executeIntent()
      .accountsPartial({
        intentRequest: intentPubkey,
        agent: agentPubkey,
        agentAccount: agentPubkey,
        vault: vaultPubkey,
        recipient,
        executionReceipt: receiptPubkey,
        authority,
      })
      .rpc();

    const vaultAfter = await provider.connection.getBalance(vaultPubkey);
    const recipientAfter = await provider.connection.getBalance(recipient);
    assert.equal(recipientAfter, 1 * SOL);
    assert.equal(vaultBefore - vaultAfter, 1 * SOL);

    const receipt = await program.account.executionReceipt.fetch(receiptPubkey);
    assert.equal(receipt.intentSeq.toNumber(), 0);
    assert.equal(receipt.valueLamports.toNumber(), 1 * SOL);
    assert.ok(receipt.recipient.equals(recipient));
    console.log(`  ✓ 1 SOL moved via CPI; receipt at ${receiptPubkey.toBase58().slice(0, 8)}…`);
  });

  // ── 3. Over-limit → rejected at rule 0 ────────────────────────────────────

  it("rejects a transfer that exceeds the MaxValue rule", async () => {
    const seq = new BN(1);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);

    await program.methods
      .submitIntent(Action.transfer, new BN(10 * SOL), Keypair.generate().publicKey)
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { rejected: {} });
    assert.equal(intent.rejectionReason, "rule 0: max value exceeded");
  });

  // ── 4. Forbidden action → rejected at rule 1 ──────────────────────────────

  it("rejects an action not permitted by the AllowedActions rule", async () => {
    const seq = new BN(2);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);

    await program.methods
      .submitIntent(Action.contractCall, new BN(1 * SOL), null)
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { rejected: {} });
    assert.equal(intent.rejectionReason, "rule 1: action not permitted");
  });

  // ── 5. Cannot execute a rejected intent ───────────────────────────────────

  it("cannot execute a rejected intent", async () => {
    const seq = new BN(2);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);
    const dummyRecipient = Keypair.generate().publicKey;

    try {
      await program.methods
        .executeIntent()
        .accountsPartial({
          intentRequest: intentPubkey,
          agent: agentPubkey,
          agentAccount: agentPubkey,
          vault: vaultPubkey,
          recipient: dummyRecipient,
          executionReceipt: receiptPubkey,
          authority,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.message, "IntentNotApproved");
    }
  });

  // ── 6. Non-Transfer execute → UnsupportedActionCpi, no receipt ────────────

  it("blocks execute_intent on non-Transfer actions with UnsupportedActionCpi", async () => {
    const seq = new BN(3);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);

    // Swap is allowed by the mask, so this gets Approved.
    await program.methods
      .submitIntent(Action.swap, new BN(1 * SOL), null)
      .accounts({ authority })
      .rpc();

    const approved = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(approved.status, { approved: {} });

    try {
      await program.methods
        .executeIntent()
        .accountsPartial({
          intentRequest: intentPubkey,
          agent: agentPubkey,
          agentAccount: agentPubkey,
          vault: vaultPubkey,
          recipient: Keypair.generate().publicKey,
          executionReceipt: receiptPubkey,
          authority,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.message, "UnsupportedActionCpi");
    }

    const receiptInfo = await provider.connection.getAccountInfo(receiptPubkey);
    assert.isNull(receiptInfo, "no receipt should be written");
  });

  // ── 7. RatePerWindow trips ────────────────────────────────────────────────

  it("rate-limits approved intents per window", async () => {
    // Fresh agent so window state is clean.
    const rlAuthority = Keypair.generate();
    await airdrop(provider, rlAuthority.publicKey, 5);
    const [rlAgent] = agentPda(rlAuthority.publicKey, program.programId);

    const rlRules = [
      Rule.maxValue(new BN(2 * SOL)),
      Rule.allowedActions(maskFor(0)),
      Rule.ratePerWindow(new BN(60), 2),
    ];

    await program.methods
      .registerAgent("rl-agent", rlRules as any, null)
      .accounts({ authority: rlAuthority.publicKey })
      .signers([rlAuthority])
      .rpc();

    const recipient = Keypair.generate().publicKey;
    const statuses: any[] = [];
    const reasons: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const seq = new BN(i);
      const [intentPubkey] = intentPda(rlAgent, seq, program.programId);
      await program.methods
        .submitIntent(Action.transfer, new BN(0.1 * SOL), recipient)
        .accounts({ authority: rlAuthority.publicKey })
        .signers([rlAuthority])
        .rpc();
      const intent = await program.account.intentRequest.fetch(intentPubkey);
      statuses.push(intent.status);
      reasons.push(intent.rejectionReason);
    }

    assert.deepEqual(statuses[0], { approved: {} });
    assert.deepEqual(statuses[1], { approved: {} });
    assert.deepEqual(statuses[2], { rejected: {} });
    assert.equal(reasons[2], "rule 2: rate limit exceeded");
  });

  // ── 8. replace_policy: authorized vs intruder ─────────────────────────────

  it("replace_policy enforces the separate policy_authority", async () => {
    const upAuthority = Keypair.generate();
    const upPolicyAuthority = Keypair.generate();
    const intruder = Keypair.generate();
    await airdrop(provider, upAuthority.publicKey, 3);
    await airdrop(provider, upPolicyAuthority.publicKey, 1);
    await airdrop(provider, intruder.publicKey, 1);

    const [upAgent] = agentPda(upAuthority.publicKey, program.programId);
    const [upPolicy] = policyPda(upAgent, program.programId);

    const initialRules = [
      Rule.maxValue(new BN(1 * SOL)),
      Rule.allowedActions(maskFor(0)),
    ];

    await program.methods
      .registerAgent("up-agent", initialRules as any, upPolicyAuthority.publicKey)
      .accounts({ authority: upAuthority.publicKey })
      .signers([upAuthority])
      .rpc();

    const before = await program.account.policyAccount.fetch(upPolicy);
    assert.equal(before.version, 0);
    assert.equal(before.rules.length, 2);

    const newRules = [
      Rule.maxValue(new BN(3 * SOL)),
      Rule.allowedActions(maskFor(0, 1)),
      Rule.ratePerWindow(new BN(30), 5),
    ];

    // Intruder fails — has_one on the context kicks them out.
    try {
      await program.methods
        .replacePolicy(newRules as any)
        .accountsPartial({
          agentAccount: upAgent,
          policyAccount: upPolicy,
          policyAuthority: intruder.publicKey,
        })
        .signers([intruder])
        .rpc();
      assert.fail("intruder should not be able to replace policy");
    } catch (err: any) {
      const msg = String(err.message ?? err);
      assert.ok(
        msg.includes("UnauthorizedPolicyUpdate") || msg.includes("ConstraintHasOne"),
        `unexpected error: ${msg}`
      );
    }

    // Real policy authority succeeds.
    await program.methods
      .replacePolicy(newRules as any)
      .accountsPartial({
        agentAccount: upAgent,
        policyAccount: upPolicy,
        policyAuthority: upPolicyAuthority.publicKey,
      })
      .signers([upPolicyAuthority])
      .rpc();

    const after = await program.account.policyAccount.fetch(upPolicy);
    assert.equal(after.version, 1);
    assert.equal(after.rules.length, 3);

    // After replace_policy, rate-window counters are reset.
    const agent = await program.account.agentAccount.fetch(upAgent);
    const newSlot = agent.windows.find((w: any) => w.active);
    assert.ok(newSlot, "new RatePerWindow rule should have a counter");
    assert.equal(newSlot.ruleIndex, 2);
    assert.equal(newSlot.count, 0);
  });

  // ── 9. (NEW) Multi-instance RatePerWindow ─────────────────────────────────

  it("supports two RatePerWindow rules with independent counters", async () => {
    const mAuthority = Keypair.generate();
    await airdrop(provider, mAuthority.publicKey, 5);
    const [mAgent] = agentPda(mAuthority.publicKey, program.programId);

    // Tight 2/60s + loose 10/3600s. The tighter rule (index 2) fires first.
    const rules = [
      Rule.maxValue(new BN(5 * SOL)),
      Rule.allowedActions(maskFor(0)),
      Rule.ratePerWindow(new BN(60), 2),
      Rule.ratePerWindow(new BN(3600), 10),
    ];

    await program.methods
      .registerAgent("multi-rl", rules as any, null)
      .accounts({ authority: mAuthority.publicKey })
      .signers([mAuthority])
      .rpc();

    const agent = await program.account.agentAccount.fetch(mAgent);
    const activeSlots = agent.windows.filter((w: any) => w.active);
    assert.equal(activeSlots.length, 2);
    const indices = activeSlots.map((w: any) => w.ruleIndex).sort();
    assert.deepEqual(indices, [2, 3]);

    const recipient = Keypair.generate().publicKey;
    const reasons: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const seq = new BN(i);
      const [intentPubkey] = intentPda(mAgent, seq, program.programId);
      await program.methods
        .submitIntent(Action.transfer, new BN(0.05 * SOL), recipient)
        .accounts({ authority: mAuthority.publicKey })
        .signers([mAuthority])
        .rpc();
      const intent = await program.account.intentRequest.fetch(intentPubkey);
      reasons.push(intent.rejectionReason);
    }

    assert.isNull(reasons[0]);
    assert.isNull(reasons[1]);
    assert.equal(reasons[2], "rule 2: rate limit exceeded");
  });

  // ── 10. (NEW) Empty rule list rejected at registration ────────────────────

  it("rejects registration with an empty rule list", async () => {
    const e = Keypair.generate();
    await airdrop(provider, e.publicKey, 2);

    try {
      await program.methods
        .registerAgent("empty", [] as any, null)
        .accounts({ authority: e.publicKey })
        .signers([e])
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(String(err.message ?? err), "EmptyPolicy");
    }
  });
});
