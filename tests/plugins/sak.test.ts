/**
 * Integration test — @basira-ai/agent-kit plugin.
 *
 * Exercises the plugin's wire-up against a real ephemeral validator: a
 * stand-in SAK agent (real wallet + connection) registers via the plugin,
 * funds its vault, runs an approved and a rejected basira_transfer, and we
 * assert the on-chain effects (receipt, recipient balance, rejection reason).
 *
 * Runs as part of `anchor test` (picked up by the ts-mocha test glob).
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";
import { BasiraPlugin } from "../../plugins/solana-agent-kit/src";

const SOL = LAMPORTS_PER_SOL;
const RPC = "http://127.0.0.1:8899";

async function airdrop(connection: Connection, to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh });
}

describe("basira plugin — solana agent kit", () => {
  const connection = new Connection(RPC, "confirmed");

  it("registers, funds, and runs approved + rejected transfers", async () => {
    // Fresh agent authority so this test owns its own agent PDA.
    const authority = Keypair.generate();
    await airdrop(connection, authority.publicKey, 10);
    const wallet = new anchor.Wallet(authority);

    // Stand-in for `new SolanaAgentKit(wallet, RPC, cfg)` — the plugin only
    // touches `wallet` and `connection`.
    const agent = { wallet, connection } as any;

    const plugin = new BasiraPlugin();
    plugin.initialize(agent);

    // ── register with a 3-rule policy ──────────────────────────────────────
    const reg = await plugin.basira.register({
      name: "sak-test-bot",
      rules: [
        { type: "MaxValue", valueSol: 1 },
        { type: "AllowedActions", actions: ["Transfer"] },
        { type: "RatePerWindow", windowSeconds: 60, max: 5 },
      ],
    });
    assert.isTrue(reg.ok);
    assert.ok(reg.agentPda);
    assert.ok(reg.policyPda);

    // ── fund the vault PDA ────────────────────────────────────────────────
    const status0 = await plugin.basira.status();
    assert.isTrue(status0.exists);
    const vault = new PublicKey(status0.vaultPda!);
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: vault,
        lamports: 2 * SOL,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, fundTx, [authority]);

    // ── approved transfer → executed, recipient balance moves ─────────────
    const recipient = Keypair.generate().publicKey;
    const before = await connection.getBalance(recipient);
    const approved = await plugin.basira.transfer({
      recipient: recipient.toBase58(),
      valueSol: 0.5,
    });
    assert.isTrue(approved.ok, "in-policy transfer should be approved");
    assert.equal(approved.status, "Executed");
    assert.ok(approved.receiptPda, "a receipt PDA should be returned");
    assert.equal(approved.txSignatures.length, 2, "submit + execute signatures");

    const after = await connection.getBalance(recipient);
    assert.equal(after - before, 0.5 * SOL, "recipient receives exactly 0.5 SOL");

    // ── over-limit transfer → rejected by the MaxValue rule ───────────────
    const rejected = await plugin.basira.transfer({
      recipient: Keypair.generate().publicKey.toBase58(),
      valueSol: 5,
    });
    assert.isFalse(rejected.ok, "over-limit transfer should be rejected");
    assert.equal(rejected.status, "Rejected");
    assert.include(rejected.rejectionReason ?? "", "rule 0");
    assert.include(rejected.rejectionReason ?? "", "max value");

    // ── status reflects the policy ────────────────────────────────────────
    const status = await plugin.basira.status();
    assert.equal(status.rules?.length, 3);
    assert.equal(status.policyVersion, 0);

    console.log(`  ✓ SAK plugin: ${approved.summary}`);
    console.log(`  ✓ SAK plugin: ${rejected.summary}`);
  });

  it("exposes the same operations as LLM-callable actions", async () => {
    const authority = Keypair.generate();
    await airdrop(connection, authority.publicKey, 5);
    const agent = { wallet: new anchor.Wallet(authority), connection } as any;

    const plugin = new BasiraPlugin();
    plugin.initialize(agent);

    // The action descriptors are what an LLM tool layer sees.
    const names = plugin.actions.map((a) => a.name);
    assert.deepEqual(names, [
      "basira_register",
      "basira_transfer",
      "basira_replace_policy",
      "basira_status",
    ]);

    // Drive registration through the action handler (the LLM path).
    const registerAction = plugin.actions.find((a) => a.name === "basira_register")!;
    const res = await registerAction.handler(agent, {
      name: "sak-action-bot",
      rules: [
        { type: "MaxValue", valueSol: 2 },
        { type: "AllowedActions", actions: ["Transfer", "Swap"] },
      ],
    });
    assert.isTrue(res.ok);

    const statusAction = plugin.actions.find((a) => a.name === "basira_status")!;
    const status = await statusAction.handler(agent, {});
    assert.equal(status.rules.length, 2);
    console.log(`  ✓ SAK plugin actions: ${status.summary}`);
  });
});
