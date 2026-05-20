/**
 * Basira end-to-end demo.
 *
 * Walks an audience through:
 *   1. Registering an agent with a *rule list* policy + separate policy
 *      authority
 *   2. In-policy Transfer → APPROVED → executed → real SOL moves via CPI
 *   3. Over-limit Transfer → REJECTED (rule 0)
 *   4. Forbidden action → REJECTED (rule 1)
 *   5. Attempting to execute the rejected intent → blocked
 *   6. Rate limit (rule 2) trips on the Nth in-policy intent
 *   7. replace_policy signed by the separate policy_authority — adds a
 *      second RatePerWindow rule and tightens allowed actions
 *
 * Usage:
 *   yarn demo                  # localnet (default)
 *   BASIRA_CLUSTER=devnet yarn demo
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BasiraClient,
  ActionTypeName,
  DecodedRule,
  Rule,
  RuleArg,
  statusName,
  summarizeRule,
  rpcUrlForCluster,
  defaultKeypairPath,
} from "../sdk/src";

const SOL = 1_000_000_000;

// ── pretty-printing helpers ───────────────────────────────────────────────────

const tag = {
  step: (n: number, t: string) =>
    console.log("\n" + chalk.bold.cyan(`▶ Step ${n}: ${t}`)),
  setup: (t: string) =>
    console.log("\n" + chalk.bold.magenta(`◆ Setup: ${t}`)),
  ok: (s: string) => console.log(chalk.green("  ✓ ") + s),
  bad: (s: string) => console.log(chalk.red("  ✗ ") + s),
  info: (s: string) => console.log(chalk.gray("    " + s)),
  hdr: (s: string) =>
    console.log(
      "\n" +
        chalk.bgCyan.black(` ${s} `) +
        chalk.cyan(" ".repeat(Math.max(0, 60 - s.length)))
    ),
  divider: () => console.log(chalk.gray("─".repeat(70))),
};

function fmtSol(lamports: BN | number) {
  const n = typeof lamports === "number" ? lamports : lamports.toNumber();
  return chalk.yellow(`${(n / SOL).toFixed(4)} SOL`);
}

function shortAddr(pk: { toBase58: () => string }) {
  const s = pk.toBase58();
  return chalk.dim(`${s.slice(0, 4)}…${s.slice(-4)}`);
}

async function pause(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function printRules(rules: DecodedRule[]) {
  rules.forEach((r, i) => tag.info(`rule ${i}: ${summarizeRule(r)}`));
}

function loadOrCreatePolicyAuthority(): Keypair {
  const p = path.join(process.cwd(), ".basira-demo-policy-authority.json");
  if (fs.existsSync(p)) {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cluster = (process.env.BASIRA_CLUSTER ?? "localnet") as
    | "localnet"
    | "devnet"
    | "mainnet-beta";

  tag.hdr("BASIRA — Trust Layer for Agentic Solana");
  console.log(chalk.gray(`    cluster: ${cluster}`));
  console.log(chalk.gray(`    keypair: ${defaultKeypairPath()}`));

  const client = new BasiraClient({ rpcUrl: rpcUrlForCluster(cluster) });
  const policyAuthority = loadOrCreatePolicyAuthority();
  console.log(chalk.gray(`    program: ${client.programId.toBase58()}`));
  console.log(chalk.gray(`    payer:   ${client.authority().toBase58()}`));
  console.log(
    chalk.gray(`    policy:  ${policyAuthority.publicKey.toBase58()}`)
  );

  const balance = await client.connection.getBalance(client.authority());
  console.log(chalk.gray(`    balance: ${(balance / SOL).toFixed(4)} SOL`));
  if (balance < 0.1 * SOL) {
    tag.bad(
      "low balance — fund the keypair before continuing (`solana airdrop 2` on devnet/local)"
    );
    process.exit(1);
  }

  const RATE_MAX = 3;
  const RATE_WINDOW_S = 60;

  const initialRules: RuleArg[] = [
    Rule.maxValue(new BN(5 * SOL)),                  // rule 0
    Rule.allowedActions(["Transfer", "Swap"]),       // rule 1
    Rule.ratePerWindow(new BN(RATE_WINDOW_S), RATE_MAX), // rule 2
  ];

  // ── Step 1: register agent (idempotent) ────────────────────────────────────

  tag.step(1, "Register an agent with a rule-list policy");
  tag.info(`agent name:        "demo-agent"`);
  tag.info(
    `policy authority:  ${chalk.yellow(
      policyAuthority.publicKey.toBase58().slice(0, 8) + "…"
    )} (separate from agent authority)`
  );
  tag.info(chalk.bold("rule list:"));
  initialRules.forEach((r, i) => {
    // decode each rule on the fly for display before we even fetch from chain.
    const key = Object.keys(r)[0];
    let summary = "";
    if (key === "maxValue") summary = `Max ${fmtSol((r as any).maxValue.lamports as BN)} per intent`;
    else if (key === "allowedActions") summary = `Allowed actions: mask=${(r as any).allowedActions.mask}`;
    else if (key === "ratePerWindow")
      summary = `${(r as any).ratePerWindow.max} approved / ${(r as any).ratePerWindow.windowSeconds.toString()}s`;
    tag.info(`  rule ${i}: ${summary}`);
  });

  const existing = await client.fetchAgentOrNull();
  if (existing) {
    tag.ok(
      `agent already exists at ${shortAddr(client.agentPda())} — reusing`
    );
  } else {
    const tx = await client.registerAgent({
      name: "demo-agent",
      rules: initialRules,
      policyAuthority: policyAuthority.publicKey,
    });
    tag.ok(`agent registered — tx ${shortAddr({ toBase58: () => tx })}`);
    tag.info(`agent PDA:  ${client.agentPda().toBase58()}`);
    tag.info(`policy PDA: ${client.policyPda().toBase58()}`);
  }

  // ── Setup: reset policy + rate-limit counters via replace_policy ─────────

  tag.setup("Reset policy & rate-limit counters via replace_policy");
  const agentBefore = await client.fetchAgent();
  const onchainPa = (agentBefore.policyAuthority as PublicKey).toBase58();

  if (onchainPa !== policyAuthority.publicKey.toBase58()) {
    tag.bad(
      `agent's policy_authority is ${onchainPa.slice(0, 8)}… but this run holds ${policyAuthority.publicKey
        .toBase58()
        .slice(0, 8)}…`
    );
    tag.bad(
      "delete .basira-demo-policy-authority.json and re-register the agent (or pass the original key)"
    );
    process.exit(1);
  }

  // Fund the policy authority so it can pay its own tx fees.
  const paBalance = await client.connection.getBalance(
    policyAuthority.publicKey
  );
  if (paBalance < 0.01 * SOL) {
    const sig = await client.connection.requestAirdrop(
      policyAuthority.publicKey,
      0.05 * SOL
    );
    const bh = await client.connection.getLatestBlockhash();
    await client.connection.confirmTransaction({ signature: sig, ...bh });
    tag.info(`funded policy authority with 0.05 SOL for tx fees`);
  }

  await client.replacePolicy({ rules: initialRules }, policyAuthority);
  tag.ok(`policy reset — rate-limit window started fresh`);

  // ── Setup: fund the vault PDA so executions can move real SOL ────────────

  tag.setup("Fund the agent's vault PDA");
  const vault = client.vaultPda();
  const vaultBefore = await client.vaultBalance();
  tag.info(`vault PDA:    ${vault.toBase58()}`);
  tag.info(`vault before: ${fmtSol(vaultBefore)}`);
  if (vaultBefore < 1.5 * SOL) {
    const topUp = Math.max(2 * SOL - vaultBefore, 1.5 * SOL);
    await client.fundVault(new BN(topUp));
    tag.ok(`vault funded with ${fmtSol(topUp)}`);
  } else {
    tag.ok(`vault already has enough lamports`);
  }
  tag.info(`vault after:  ${fmtSol(await client.vaultBalance())}`);

  // ── Scenario helpers ──────────────────────────────────────────────────────

  async function submitAndReport(
    action: ActionTypeName,
    valueSol: number,
    recipient: PublicKey | null
  ) {
    const { tx, intent, seq } = await client.submitIntent({
      action,
      valueLamports: new BN(valueSol * SOL),
      recipient,
    });
    tag.info(`submit tx:    ${shortAddr({ toBase58: () => tx })}`);
    tag.info(`intent #${seq.toString()} pda: ${shortAddr(intent)}`);
    const intentAccount = await client.fetchIntent(seq);
    const status = statusName(intentAccount.status);
    if (status === "Approved") {
      tag.ok(`policy decision: ${chalk.green.bold("APPROVED")}`);
    } else {
      tag.bad(
        `policy decision: ${chalk.red.bold("REJECTED")} — ${
          intentAccount.rejectionReason ?? ""
        }`
      );
    }
    return { seq, status, intentAccount };
  }

  // ── Step 2: in-policy Transfer → APPROVED → executed → balance moves ─────

  tag.step(2, "In-policy transfer → APPROVED → executed → SOL actually moves");
  const recipient = Keypair.generate().publicKey;
  tag.info(`recipient:    ${recipient.toBase58()}`);
  const recipientBefore = await client.connection.getBalance(recipient);
  tag.info(`recipient before: ${fmtSol(recipientBefore)}`);

  const transfer = await submitAndReport("Transfer", 1, recipient);
  if (transfer.status !== "Approved") {
    throw new Error("expected step 2 to be Approved");
  }
  const exec = await client.executeIntent(transfer.seq);
  const recipientAfter = await client.connection.getBalance(recipient);
  const vaultAfterExec = await client.vaultBalance();
  tag.ok(
    `receipt written — pda ${shortAddr(exec.receipt)} tx ${shortAddr({
      toBase58: () => exec.tx,
    })}`
  );
  tag.info(`recipient after:  ${fmtSol(recipientAfter)}`);
  tag.info(`vault after exec: ${fmtSol(vaultAfterExec)}`);
  tag.ok(
    `${chalk.bold("real SOL moved")}: recipient +${fmtSol(
      recipientAfter - recipientBefore
    )}`
  );

  await pause(400);

  // ── Step 3: over-limit Transfer → rule 0 fires ───────────────────────────

  tag.step(3, "Over-limit transfer → REJECTED by rule 0 (MaxValue)");
  await submitAndReport("Transfer", 10, Keypair.generate().publicKey);

  await pause(400);

  // ── Step 4: forbidden action → rule 1 fires ──────────────────────────────

  tag.step(4, "Forbidden action → REJECTED by rule 1 (AllowedActions)");
  const rejected = await submitAndReport("ContractCall", 1, null);
  if (rejected.status !== "Rejected") {
    throw new Error("expected step 4 to be Rejected");
  }

  await pause(400);

  // ── Step 5: cannot execute a rejected intent ─────────────────────────────

  tag.step(5, "Try to execute the rejected intent → blocked");
  try {
    await client.executeIntent(rejected.seq, Keypair.generate().publicKey);
    tag.bad("expected execution to fail, but it succeeded");
  } catch (e: any) {
    tag.ok(
      `blocked by IntentNotApproved guard: ${chalk.dim(
        (e.message || "").split("\n")[0].slice(0, 90)
      )}`
    );
  }

  await pause(400);

  // ── Step 6: rate limit trips → rule 2 fires ──────────────────────────────

  tag.step(6, "Rate limit trips after N approved intents in the window");
  // We've already burned 1 approved intent in step 2. The window resets on
  // replace_policy in Setup, so we have RATE_MAX-1 left before the trip.
  let tripped = false;
  for (let i = 0; i < RATE_MAX + 2 && !tripped; i++) {
    const r = await submitAndReport(
      "Transfer",
      0.1,
      Keypair.generate().publicKey
    );
    if (
      r.status === "Rejected" &&
      (r.intentAccount.rejectionReason ?? "").includes("rate limit exceeded")
    ) {
      tripped = true;
      tag.ok(
        `${chalk.bold("rule 2 fired")} after ${RATE_MAX} approved intents`
      );
    }
  }
  if (!tripped) {
    tag.bad("rate limit never tripped — check window settings");
  }

  await pause(400);

  // ── Step 7: replace_policy signed by the separate policy authority ───────

  tag.step(7, "replace_policy by the policy_authority (not the agent)");
  const beforeRules = await client.fetchRules();
  tag.info(chalk.bold("before:"));
  printRules(beforeRules);

  // New policy: tighter MaxValue, only Transfer allowed, AND two
  // RatePerWindow rules (one fast, one slow) — demonstrating that the rule
  // list can contain multiple instances of the same rule type.
  const newRules: RuleArg[] = [
    Rule.maxValue(new BN(2 * SOL)),
    Rule.allowedActions(["Transfer"]),
    Rule.ratePerWindow(new BN(10), 2),     // 2 per 10s (tight)
    Rule.ratePerWindow(new BN(3600), 50),  // 50 per hour (loose)
  ];
  await client.replacePolicy({ rules: newRules }, policyAuthority);

  const afterRules = await client.fetchRules();
  tag.info(chalk.bold("after:"));
  printRules(afterRules);
  tag.ok(
    `policy updated by ${chalk.bold(
      shortAddr(policyAuthority.publicKey).toString()
    )} — the agent's authority cannot do this`
  );

  // ── Summary ───────────────────────────────────────────────────────────────

  tag.divider();
  tag.hdr(" SUMMARY ");

  const agent = await client.fetchAgent();
  const policy = await client.fetchPolicy();
  const rules = await client.fetchRules();
  const intents = await client.listIntents();
  const receipts = await client.listReceipts();

  console.log(
    `  agent:    ${chalk.bold(agent.name)}  (${shortAddr(client.agentPda())})`
  );
  console.log(`  policy:   version ${policy.version}  ·  ${rules.length} rules`);
  rules.forEach((r, i) =>
    console.log(`            rule ${i}: ${summarizeRule(r)}`)
  );
  console.log(
    `  vault:    ${fmtSol(await client.vaultBalance())} (${shortAddr(
      client.vaultPda()
    )})`
  );
  console.log(`  intents:  ${chalk.bold(intents.length.toString())} total`);
  console.log(`  receipts: ${chalk.bold(receipts.length.toString())} on-chain`);

  console.log("\n  " + chalk.bold("Recent intents:"));
  for (const { account } of intents.slice(-8)) {
    const s = statusName(account.status);
    const colour =
      s === "Approved"
        ? chalk.green
        : s === "Executed"
        ? chalk.green
        : s === "Rejected"
        ? chalk.red
        : chalk.gray;
    console.log(
      `    #${(account.seq as BN).toString().padStart(2)}  ${colour(
        s.padEnd(9)
      )}  action=${Object.keys(account.actionType)[0].padEnd(13)} value=${fmtSol(
        account.valueLamports as BN
      )}` +
        (account.rejectionReason
          ? `  ${chalk.dim(`(${account.rejectionReason})`)}`
          : "")
    );
  }

  console.log("\n" + chalk.green.bold("✓ demo complete"));
  console.log(
    chalk.gray(
      `\n  view on explorer (cluster=${cluster}): https://explorer.solana.com/address/${client
        .agentPda()
        .toBase58()}?cluster=${cluster}`
    )
  );
}

main().catch((e) => {
  console.error(chalk.red("\n✗ demo failed:"), e);
  process.exit(1);
});
