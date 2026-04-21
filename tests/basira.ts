import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Basira } from "../target/types/basira";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

// ── helpers ───────────────────────────────────────────────────────────────────

const SOL = 1_000_000_000; // lamports

function agentPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
    programId
  );
}

function intentPda(
  agentPda: PublicKey,
  seq: BN,
  programId: PublicKey
): [PublicKey, number] {
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(BigInt(seq.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), agentPda.toBuffer(), seqBuf],
    programId
  );
}

function receiptPda(
  agentPda: PublicKey,
  seq: BN,
  programId: PublicKey
): [PublicKey, number] {
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(BigInt(seq.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), agentPda.toBuffer(), seqBuf],
    programId
  );
}

// ── action type helpers ───────────────────────────────────────────────────────
// Anchor encodes enums as objects with a single key
const Action = {
  transfer:     { transfer: {} },
  swap:         { swap: {} },
  stake:        { stake: {} },
  contractCall: { contractCall: {} },
};

// Allowed actions bitmask: bit 0 = Transfer, 1 = Swap, 2 = Stake, 3 = ContractCall
function maskFor(...actions: number[]): number {
  return actions.reduce((acc, bit) => acc | (1 << bit), 0);
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("basira", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Basira as Program<Basira>;
  const authority = (program.provider as anchor.AnchorProvider).wallet.publicKey;

  const MAX_VALUE = new BN(5 * SOL); // 5 SOL ceiling
  // Allow Transfer (bit 0) and Swap (bit 1) only → mask = 0b0011 = 3
  const ALLOWED_MASK = maskFor(0, 1);

  let [agentPubkey] = agentPda(authority, program.programId);

  // ── Registration ────────────────────────────────────────────────────────────

  it("registers an agent with a risk policy", async () => {
    await program.methods
      .registerAgent("demo-agent", MAX_VALUE, ALLOWED_MASK)
      .accounts({ authority })
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPubkey);
    assert.equal(agent.name, "demo-agent");
    assert.equal(agent.policy.maxValueLamports.toNumber(), MAX_VALUE.toNumber());
    assert.equal(agent.policy.allowedActionsMask, ALLOWED_MASK);
    assert.equal(agent.intentCount.toNumber(), 0);

    console.log(`  ✓ agent registered: ${agentPubkey.toBase58()}`);
  });

  // ── Scenario A — intent within policy → Approved → Executed ────────────────

  it("approves and executes a transfer within policy limits", async () => {
    const seq = new BN(0);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);

    // submit
    await program.methods
      .submitIntent(Action.transfer, new BN(1 * SOL))
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { approved: {} }, "intent should be Approved");
    assert.isNull(intent.rejectionReason);
    console.log(`  ✓ intent #${seq} approved (transfer, 1 SOL)`);

    // execute
    await program.methods
      .executeIntent()
      .accounts({
        intentRequest: intentPubkey,
        agent: agentPubkey,
        executionReceipt: receiptPubkey,
        authority,
      })
      .rpc();

    const executed = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(executed.status, { executed: {} }, "intent should be Executed");
    assert.isNotNull(executed.finalisedAt);

    const receipt = await program.account.executionReceipt.fetch(receiptPubkey);
    assert.equal(receipt.intentSeq.toNumber(), 0);
    assert.equal(receipt.valueLamports.toNumber(), 1 * SOL);
    console.log(`  ✓ receipt written for intent #${seq} at ts=${receipt.executedAt}`);
  });

  // ── Scenario B — value exceeds policy max → Rejected ───────────────────────

  it("rejects a transfer that exceeds the value limit", async () => {
    const seq = new BN(1);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);

    await program.methods
      .submitIntent(Action.transfer, new BN(10 * SOL)) // 10 SOL > 5 SOL limit
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { rejected: {} }, "intent should be Rejected");
    assert.equal(intent.rejectionReason, "value exceeds policy limit");
    console.log(`  ✓ intent #${seq} rejected — value 10 SOL exceeds 5 SOL limit`);
  });

  // ── Scenario C — forbidden action type → Rejected ──────────────────────────

  it("rejects a contract call not permitted by policy", async () => {
    const seq = new BN(2);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);

    await program.methods
      .submitIntent(Action.contractCall, new BN(1 * SOL))
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { rejected: {} }, "intent should be Rejected");
    assert.equal(intent.rejectionReason, "action type not permitted");
    console.log(`  ✓ intent #${seq} rejected — ContractCall not in policy`);
  });

  // ── Scenario D — cannot execute a rejected intent ──────────────────────────

  it("cannot execute a rejected intent", async () => {
    const seq = new BN(2); // the rejected one from above
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);

    try {
      await program.methods
        .executeIntent()
        .accounts({
          intentRequest: intentPubkey,
          agent: agentPubkey,
          executionReceipt: receiptPubkey,
          authority,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.message, "IntentNotApproved");
      console.log(`  ✓ execute correctly blocked for rejected intent #${seq}`);
    }
  });
});
