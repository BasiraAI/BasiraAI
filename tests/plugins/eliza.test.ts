/**
 * Integration test — @basira-ai/eliza-plugin.
 *
 * Drives the plugin's action handlers against a real ephemeral validator
 * using a stubbed Eliza runtime (just `getSetting`). We assert the on-chain
 * effects and the callback payloads the actions emit back to the character.
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
import { basiraPlugin } from "../../plugins/eliza/src";

const SOL = LAMPORTS_PER_SOL;
const RPC = "http://127.0.0.1:8899";

/** Minimal stub of the Eliza runtime — the plugin only calls getSetting. */
function stubRuntime(keypair: Keypair) {
  const settings: Record<string, string> = {
    SOLANA_RPC_URL: RPC,
    SOLANA_PRIVATE_KEY: JSON.stringify(Array.from(keypair.secretKey)),
  };
  return { getSetting: (k: string) => settings[k] };
}

async function airdrop(connection: Connection, to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh });
}

function action(name: string) {
  const a = basiraPlugin.actions.find((x) => x.name === name);
  if (!a) throw new Error(`action ${name} not found`);
  return a;
}

describe("basira plugin — elizaos", () => {
  const connection = new Connection(RPC, "confirmed");

  it("registers and runs a policy-gated transfer through the action handlers", async () => {
    const authority = Keypair.generate();
    await airdrop(connection, authority.publicKey, 10);
    const runtime = stubRuntime(authority);

    // Capture what the action emits back to the conversation.
    const callbacks: any[] = [];
    const cb = async (r: any) => {
      callbacks.push(r);
    };

    // ── BASIRA_REGISTER ────────────────────────────────────────────────────
    const reg = await action("BASIRA_REGISTER").handler(
      runtime as any,
      { content: {} } as any,
      undefined,
      {
        name: "eliza-test-bot",
        rules: [
          { type: "MaxValue", valueSol: 1 },
          { type: "AllowedActions", actions: ["Transfer"] },
          { type: "RatePerWindow", windowSeconds: 60, max: 5 },
        ],
      },
      cb
    );
    assert.isTrue((reg as any).success);
    assert.isTrue((reg as any).data.ok);
    assert.match(callbacks[callbacks.length - 1].text, /Registered agent/);

    // ── fund the vault ────────────────────────────────────────────────────
    const statusRes: any = await action("BASIRA_STATUS").handler(
      runtime as any,
      { content: {} } as any,
      undefined,
      {},
      cb
    );
    const vault = new PublicKey(statusRes.data.vaultPda);
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: vault,
        lamports: 2 * SOL,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, fundTx, [authority]);

    // ── BASIRA_TRANSFER — approved, moves real SOL ────────────────────────
    const recipient = Keypair.generate().publicKey;
    const before = await connection.getBalance(recipient);
    const approved: any = await action("BASIRA_TRANSFER").handler(
      runtime as any,
      { content: { text: "send 0.5 SOL" } } as any,
      undefined,
      { recipient: recipient.toBase58(), valueSol: 0.5 },
      cb
    );
    assert.isTrue(approved.success);
    assert.equal(approved.data.status, "Executed");
    const after = await connection.getBalance(recipient);
    assert.equal(after - before, 0.5 * SOL, "recipient receives exactly 0.5 SOL");

    // ── BASIRA_TRANSFER — rejected by the MaxValue rule ───────────────────
    const rejected: any = await action("BASIRA_TRANSFER").handler(
      runtime as any,
      { content: { text: "send 5 SOL" } } as any,
      undefined,
      { recipient: Keypair.generate().publicKey.toBase58(), valueSol: 5 },
      cb
    );
    assert.isFalse(rejected.success);
    assert.equal(rejected.data.status, "Rejected");
    assert.include(rejected.data.rejectionReason ?? "", "rule 0");

    // The last callback text should describe the rejection.
    const lastText = callbacks[callbacks.length - 1].text;
    assert.match(lastText, /REJECTED/);
    console.log(`  ✓ Eliza plugin: ${approved.data.summary}`);
    console.log(`  ✓ Eliza plugin: ${rejected.data.summary}`);
  });

  it("the policy provider injects the live rule list into context", async () => {
    const authority = Keypair.generate();
    await airdrop(connection, authority.publicKey, 5);
    const runtime = stubRuntime(authority);

    // Before registration, the provider tells the model to register.
    const pre = await basiraPlugin.providers![0].get(
      runtime as any,
      { content: {} } as any,
      {} as any
    );
    assert.match(pre.text ?? "", /not yet registered/);

    // Register, then the provider should describe the policy.
    await action("BASIRA_REGISTER").handler(
      runtime as any,
      { content: {} } as any,
      undefined,
      {
        name: "eliza-provider-bot",
        rules: [
          { type: "MaxValue", valueSol: 2 },
          { type: "AllowedActions", actions: ["Transfer", "Swap"] },
        ],
      },
      undefined
    );

    const post = await basiraPlugin.providers![0].get(
      runtime as any,
      { content: {} } as any,
      {} as any
    );
    assert.match(post.text ?? "", /Basira policy \(version 0\)/);
    assert.match(post.text ?? "", /rule 0/);
    assert.match(post.text ?? "", /BASIRA_TRANSFER/);
    console.log(`  ✓ Eliza plugin provider injects policy context`);
  });
});
