/**
 * Basira demo web server.
 *
 * Tiny Express app that exposes the SDK over HTTP and serves a single-page UI
 * from `web/public/`. Designed for live demos — refresh-friendly, idempotent
 * registration, and a JSON shape that's easy to render.
 *
 * The server holds a long-lived "policy authority" keypair on disk so it can
 * sign `replace_policy` calls. That key is distinct from the agent's signing
 * authority (the server's wallet). In production the policy authority would
 * be held by a different principal (human, multisig, etc.).
 */

import express from "express";
import path from "path";
import fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BasiraClient,
  ActionTypeName,
  Rule,
  RuleArg,
  DecodedRule,
  decodeRule,
  summarizeRule,
  validateRules,
  statusName,
  rpcUrlForCluster,
} from "../sdk/src";

const SOL = 1_000_000_000;

const PORT = Number(process.env.PORT ?? 4000);
const CLUSTER = (process.env.BASIRA_CLUSTER ?? "localnet") as
  | "localnet"
  | "devnet"
  | "mainnet-beta";

const client = new BasiraClient({ rpcUrl: rpcUrlForCluster(CLUSTER) });

// ── policy authority — persisted across server restarts ──────────────────────

function loadOrCreatePolicyAuthority(): Keypair {
  const p = path.join(process.cwd(), ".basira-web-policy-authority.json");
  if (fs.existsSync(p)) {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const policyAuthority = loadOrCreatePolicyAuthority();

async function ensurePolicyAuthorityFunded() {
  const bal = await client.connection.getBalance(policyAuthority.publicKey);
  if (bal >= 0.01 * SOL) return;
  if (CLUSTER === "localnet") {
    const sig = await client.connection.requestAirdrop(
      policyAuthority.publicKey,
      0.05 * SOL
    );
    const bh = await client.connection.getLatestBlockhash();
    await client.connection.confirmTransaction({ signature: sig, ...bh });
  } else {
    throw new Error(
      `policy authority ${policyAuthority.publicKey.toBase58()} needs ~0.01 SOL for tx fees on ${CLUSTER}`
    );
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── rule (de)serialization for the UI ────────────────────────────────────────

/**
 * Friendly JSON shape the UI uses. Server translates to/from the SDK's
 * Anchor-encoded RuleArg.
 */
type RuleDto =
  | { type: "MaxValue"; lamports: string } // bigint as string for JSON safety
  | { type: "AllowedActions"; actions: ActionTypeName[] }
  | { type: "RatePerWindow"; windowSeconds: number; max: number };

function dtoToRuleArg(dto: RuleDto): RuleArg {
  switch (dto.type) {
    case "MaxValue":
      return Rule.maxValue(new BN(dto.lamports));
    case "AllowedActions":
      return Rule.allowedActions(dto.actions);
    case "RatePerWindow":
      return Rule.ratePerWindow(dto.windowSeconds, dto.max);
  }
}

function decodedToDto(d: DecodedRule): RuleDto & { summary: string } {
  const summary = summarizeRule(d);
  switch (d.type) {
    case "MaxValue":
      return { type: "MaxValue", lamports: d.lamports.toString(), summary };
    case "AllowedActions":
      return { type: "AllowedActions", actions: d.actions, summary };
    case "RatePerWindow":
      return {
        type: "RatePerWindow",
        windowSeconds: d.windowSeconds,
        max: d.max,
        summary,
      };
  }
}

function parseRulesBody(rulesIn: any): RuleArg[] {
  if (!Array.isArray(rulesIn)) throw new Error("`rules` must be an array");
  const out: RuleArg[] = rulesIn.map((r) => {
    if (!r || typeof r !== "object") throw new Error("invalid rule");
    switch (r.type) {
      case "MaxValue": {
        if (r.lamports === undefined) throw new Error("MaxValue.lamports required");
        return dtoToRuleArg({ type: "MaxValue", lamports: String(r.lamports) });
      }
      case "AllowedActions": {
        if (!Array.isArray(r.actions))
          throw new Error("AllowedActions.actions must be an array");
        return dtoToRuleArg({ type: "AllowedActions", actions: r.actions });
      }
      case "RatePerWindow": {
        if (r.windowSeconds === undefined || r.max === undefined)
          throw new Error("RatePerWindow.windowSeconds and .max required");
        return dtoToRuleArg({
          type: "RatePerWindow",
          windowSeconds: Number(r.windowSeconds),
          max: Number(r.max),
        });
      }
      default:
        throw new Error(`unknown rule type: ${r.type}`);
    }
  });
  validateRules(out);
  return out;
}

// ── account serializers ──────────────────────────────────────────────────────

function serializeIntent(account: any, pubkey: any) {
  const recipient = (account.recipient as PublicKey).toBase58();
  return {
    pubkey: pubkey.toBase58(),
    seq: (account.seq as BN).toNumber(),
    actionType: Object.keys(account.actionType)[0],
    valueLamports: (account.valueLamports as BN).toString(),
    valueSol: (account.valueLamports as BN).toNumber() / SOL,
    recipient,
    status: statusName(account.status),
    rejectionReason: account.rejectionReason ?? null,
    submittedAt: Number(account.submittedAt),
    finalisedAt: account.finalisedAt ? Number(account.finalisedAt) : null,
    agent: account.agent.toBase58(),
  };
}

function serializeReceipt(account: any, pubkey: any) {
  return {
    pubkey: pubkey.toBase58(),
    intentSeq: (account.intentSeq as BN).toNumber(),
    actionType: Object.keys(account.actionType)[0],
    valueLamports: (account.valueLamports as BN).toString(),
    valueSol: (account.valueLamports as BN).toNumber() / SOL,
    recipient: (account.recipient as PublicKey).toBase58(),
    executedAt: Number(account.executedAt),
    agent: account.agent.toBase58(),
  };
}

function serializeWindows(windows: any[]) {
  return windows
    .filter((w) => w.active)
    .map((w) => ({
      ruleIndex: w.ruleIndex,
      count: w.count,
      startTs: (w.startTs as BN).toNumber(),
    }));
}

// ── routes ─────────────────────────────────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  try {
    const balance = await client.connection.getBalance(client.authority());
    const vault = client.vaultPda();
    const vaultBalance = await client.connection.getBalance(vault);
    res.json({
      cluster: CLUSTER,
      programId: client.programId.toBase58(),
      payer: client.authority().toBase58(),
      payerBalanceSol: balance / SOL,
      agentPda: client.agentPda().toBase58(),
      policyPda: client.policyPda().toBase58(),
      vaultPda: vault.toBase58(),
      vaultBalanceSol: vaultBalance / SOL,
      policyAuthority: policyAuthority.publicKey.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agent", async (_req, res) => {
  try {
    const agent = await client.fetchAgentOrNull();
    if (!agent) return res.json({ exists: false });
    const policy = await client.fetchPolicyOrNull();
    const vault = client.vaultPda();
    const vaultBalance = await client.connection.getBalance(vault);
    const rules = policy
      ? (policy.rules as any[]).map((r) => decodedToDto(decodeRule(r)))
      : [];
    res.json({
      exists: true,
      pubkey: client.agentPda().toBase58(),
      authority: agent.authority.toBase58(),
      policyAuthority: (agent.policyAuthority as PublicKey).toBase58(),
      name: agent.name,
      intentCount: (agent.intentCount as BN).toNumber(),
      windows: serializeWindows(agent.windows as any[]),
      vaultPda: vault.toBase58(),
      vaultBalanceSol: vaultBalance / SOL,
      policy: policy
        ? {
            pubkey: client.policyPda().toBase58(),
            version: policy.version,
            rules,
          }
        : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/register", async (req, res) => {
  try {
    const { name, rules } = req.body as { name: string; rules: any };
    if (!name) return res.status(400).json({ error: "`name` required" });
    let ruleArgs: RuleArg[];
    try {
      ruleArgs = parseRulesBody(rules);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
    const existing = await client.fetchAgentOrNull();
    if (existing) {
      return res
        .status(409)
        .json({ error: "agent already exists for this authority" });
    }
    const tx = await client.registerAgent({
      name,
      rules: ruleArgs,
      policyAuthority: policyAuthority.publicKey,
    });
    res.json({ ok: true, tx, agentPda: client.agentPda().toBase58() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/policy", async (req, res) => {
  try {
    const { rules } = req.body as { rules: any };
    let ruleArgs: RuleArg[];
    try {
      ruleArgs = parseRulesBody(rules);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
    await ensurePolicyAuthorityFunded();
    const tx = await client.replacePolicy({ rules: ruleArgs }, policyAuthority);
    res.json({ ok: true, tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/agent/vault/fund", async (req, res) => {
  try {
    const { sol } = req.body as { sol: number };
    if (!sol || sol <= 0) {
      return res.status(400).json({ error: "sol must be > 0" });
    }
    const tx = await client.fundVault(new BN(Math.floor(sol * SOL)));
    const vaultBalance = await client.connection.getBalance(client.vaultPda());
    res.json({ ok: true, tx, vaultBalanceSol: vaultBalance / SOL });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/intent", async (req, res) => {
  try {
    const { action, valueSol, recipient, autoExecute } = req.body as {
      action: ActionTypeName;
      valueSol: number;
      recipient?: string | null;
      autoExecute?: boolean;
    };
    let recipientKey: PublicKey | null = null;
    if (recipient) {
      try {
        recipientKey = new PublicKey(recipient);
      } catch {
        return res.status(400).json({ error: "invalid recipient pubkey" });
      }
    }
    if (action === "Transfer" && !recipientKey) {
      return res.status(400).json({ error: "Transfer requires a recipient" });
    }

    const submit = await client.submitIntent({
      action,
      valueLamports: new BN(Math.floor(valueSol * SOL)),
      recipient: recipientKey,
    });
    const intent = await client.fetchIntent(submit.seq);
    const status = statusName(intent.status);

    let executeTx: string | null = null;
    let receipt: any = null;
    if (autoExecute && status === "Approved") {
      const exec = await client.executeIntent(submit.seq);
      executeTx = exec.tx;
      const r = await client.fetchReceipt(submit.seq);
      receipt = serializeReceipt(r, exec.receipt);
    }

    res.json({
      submitTx: submit.tx,
      seq: submit.seq.toNumber(),
      intent: serializeIntent(intent, submit.intent),
      executeTx,
      receipt,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/intent/:seq/execute", async (req, res) => {
  try {
    const seq = Number(req.params.seq);
    const exec = await client.executeIntent(seq);
    const r = await client.fetchReceipt(seq);
    res.json({
      ok: true,
      tx: exec.tx,
      receipt: serializeReceipt(r, exec.receipt),
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/intents", async (_req, res) => {
  try {
    const xs = await client.listIntents();
    res.json(xs.map((x) => serializeIntent(x.account, x.pubkey)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/receipts", async (_req, res) => {
  try {
    const xs = await client.listReceipts();
    res.json(xs.map((x) => serializeReceipt(x.account, x.pubkey)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Basira demo server`);
  console.log(`  cluster:          ${CLUSTER}`);
  console.log(`  program:          ${client.programId.toBase58()}`);
  console.log(`  payer:            ${client.authority().toBase58()}`);
  console.log(`  policy authority: ${policyAuthority.publicKey.toBase58()}`);
  console.log(`\n  → http://localhost:${PORT}\n`);
});
