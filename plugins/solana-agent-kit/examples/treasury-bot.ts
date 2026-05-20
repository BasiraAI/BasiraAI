/**
 * Example — a treasury bot built on Solana Agent Kit + the Basira plugin.
 *
 * Shows the integration end to end:
 *   1. Build a (stand-in) SAK agent and `.use(new BasiraPlugin())`.
 *   2. Register the agent with a 3-rule policy.
 *   3. Fund the agent's vault PDA.
 *   4. Call basira_transfer for an in-policy amount → APPROVED + executed.
 *   5. Call basira_transfer for an over-limit amount → REJECTED on-chain.
 *
 * Run against a local validator with the program deployed:
 *   solana-test-validator --reset      (separate terminal)
 *   anchor deploy --provider.cluster localnet
 *   ts-node plugins/solana-agent-kit/examples/treasury-bot.ts
 *
 * NOTE: a real project would `import { SolanaAgentKit } from "solana-agent-kit"`.
 * Here we hand-build the minimal agent shape the plugin needs (wallet +
 * connection) so the example runs without the SAK dependency.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { BasiraPlugin } from "../src";
import { loadKeypair, defaultKeypairPath } from "@basira-ai/sdk";

const SOL = 1_000_000_000;
const RPC = process.env.BASIRA_RPC ?? "http://127.0.0.1:8899";

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = loadKeypair(defaultKeypairPath());
  const wallet = new anchor.Wallet(payer);

  // Stand-in for `new SolanaAgentKit(wallet, RPC, cfg)`.
  const agent = { wallet, connection };

  // Register the Basira plugin — exactly what `.use(new BasiraPlugin())` does.
  const basira = new BasiraPlugin();
  basira.initialize(agent);

  console.log("treasury-bot — Basira x Solana Agent Kit\n");
  console.log("  agent authority:", payer.publicKey.toBase58());

  // ── 1. Register the agent with a 3-rule policy ───────────────────────────
  const policyAuthority = Keypair.generate();
  const status0 = await basira.basira.status();
  if (!status0.exists) {
    const reg = await basira.basira.register({
      name: "treasury-bot",
      rules: [
        { type: "MaxValue", valueSol: 1 },
        { type: "AllowedActions", actions: ["Transfer"] },
        { type: "RatePerWindow", windowSeconds: 60, max: 5 },
      ],
      policyAuthority: policyAuthority.publicKey.toBase58(),
    });
    console.log("  ✓", reg.summary);
  } else {
    console.log("  ✓ agent already registered — reusing");
  }

  // ── 2. Fund the agent's vault PDA so transfers can move real SOL ─────────
  const status = await basira.basira.status();
  const vault = status.vaultPda!;
  const vaultBal = status.vaultBalanceSol ?? 0;
  if (vaultBal < 1) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new anchor.web3.PublicKey(vault),
        lamports: 2 * SOL,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("  ✓ funded vault with 2 SOL");
  } else {
    console.log(`  ✓ vault already funded (${vaultBal.toFixed(2)} SOL)`);
  }

  // ── 3. In-policy transfer → APPROVED + executed ──────────────────────────
  const recipient = Keypair.generate().publicKey;
  const before = await connection.getBalance(recipient);
  const approved = await basira.basira.transfer({
    recipient: recipient.toBase58(),
    valueSol: 0.5,
  });
  const after = await connection.getBalance(recipient);
  console.log("\n  in-policy transfer (0.5 SOL):");
  console.log("   ", approved.summary);
  console.log(`    recipient balance: ${before / SOL} → ${after / SOL} SOL`);

  // ── 4. Over-limit transfer → REJECTED by the MaxValue rule ───────────────
  const rejected = await basira.basira.transfer({
    recipient: Keypair.generate().publicKey.toBase58(),
    valueSol: 5,
  });
  console.log("\n  over-limit transfer (5 SOL):");
  console.log("   ", rejected.summary);

  // ── 5. Final status ──────────────────────────────────────────────────────
  const finalStatus = await basira.basira.status();
  console.log("\n  final policy:");
  finalStatus.rules?.forEach((r) => console.log(`    rule ${r.index}: ${r.summary}`));

  console.log("\n✓ example complete");
}

main().catch((e) => {
  console.error("\n✗ example failed:", e);
  process.exit(1);
});
