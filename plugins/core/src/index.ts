/**
 * @basira-ai/plugin-core — framework-agnostic Basira action functions.
 *
 * These are the operations a framework plugin (Solana Agent Kit, ElizaOS,
 * GOAT, ...) exposes to an autonomous agent. They wrap the BasiraClient SDK
 * and return small, JSON-friendly result objects that an LLM tool layer can
 * pass straight back into a model's context.
 *
 * Nothing here imports a framework — the SAK and Eliza plugins depend on this
 * module, not the other way around.
 */

import {
  BasiraClient,
  ActionTypeName,
  RuleArg,
  DecodedRule,
  BN,
  PublicKey,
  Keypair,
  statusName,
  summarizeRule,
} from "@basira-ai/sdk";

const SOL = 1_000_000_000;

// ── result shapes ─────────────────────────────────────────────────────────────

/** Outcome of a submit (and optional execute) flow. */
export interface IntentResult {
  ok: boolean;
  /** Final status of the intent on-chain. */
  status: "Approved" | "Rejected" | "Executed";
  seq: number;
  intentPda: string;
  /** Present only when the intent was executed and a receipt was written. */
  receiptPda?: string;
  /** Present only on rejection — includes the firing rule index, e.g. "rule 2: rate limit exceeded". */
  rejectionReason?: string;
  /** All transaction signatures produced (submit, and execute if it ran). */
  txSignatures: string[];
  /** Human-readable one-liner suitable for an LLM tool response. */
  summary: string;
}

export interface RegisterResult {
  ok: boolean;
  tx: string;
  agentPda: string;
  policyPda: string;
  summary: string;
}

export interface PolicyResult {
  ok: boolean;
  tx: string;
  version: number;
  summary: string;
}

export interface StatusResult {
  ok: boolean;
  exists: boolean;
  agentPda?: string;
  authority?: string;
  policyAuthority?: string;
  name?: string;
  intentCount?: number;
  vaultPda?: string;
  vaultBalanceSol?: number;
  policyVersion?: number;
  rules?: { index: number; summary: string }[];
  windows?: { ruleIndex: number; count: number }[];
  summary: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function lamports(valueSol: number): BN {
  return new BN(Math.floor(valueSol * SOL));
}

// ── actions ───────────────────────────────────────────────────────────────────

/** Register the calling wallet's agent with an initial rule-list policy. */
export async function basiraRegister(
  client: BasiraClient,
  args: { name: string; rules: RuleArg[]; policyAuthority?: PublicKey | null }
): Promise<RegisterResult> {
  const existing = await client.fetchAgentOrNull();
  if (existing) {
    throw new Error("agent already registered for this authority");
  }
  const tx = await client.registerAgent({
    name: args.name,
    rules: args.rules,
    policyAuthority: args.policyAuthority ?? null,
  });
  const agentPda = client.agentPda().toBase58();
  const policyPda = client.policyPda().toBase58();
  return {
    ok: true,
    tx,
    agentPda,
    policyPda,
    summary: `Registered agent "${args.name}" with ${args.rules.length} policy rule(s).`,
  };
}

/**
 * Submit an intent, and if the policy approves it, execute it in the same
 * call. This is the common path a framework action exposes to an agent.
 */
export async function basiraSubmitAndExecute(
  client: BasiraClient,
  args: { action: ActionTypeName; valueSol: number; recipient?: PublicKey | null }
): Promise<IntentResult> {
  const submit = await client.submitIntent({
    action: args.action,
    valueLamports: lamports(args.valueSol),
    recipient: args.recipient ?? null,
  });
  const intent = await client.fetchIntent(submit.seq);
  const status = statusName(intent.status);
  const txSignatures = [submit.tx];

  if (status !== "Approved") {
    return {
      ok: false,
      status: "Rejected",
      seq: submit.seq.toNumber(),
      intentPda: submit.intent.toBase58(),
      rejectionReason: intent.rejectionReason ?? "rejected",
      txSignatures,
      summary: `Intent #${submit.seq.toString()} REJECTED by policy — ${
        intent.rejectionReason ?? "no reason"
      }.`,
    };
  }

  const exec = await client.executeIntent(submit.seq);
  txSignatures.push(exec.tx);
  return {
    ok: true,
    status: "Executed",
    seq: submit.seq.toNumber(),
    intentPda: submit.intent.toBase58(),
    receiptPda: exec.receipt.toBase58(),
    txSignatures,
    summary: `Intent #${submit.seq.toString()} APPROVED and executed — receipt ${exec.receipt
      .toBase58()
      .slice(0, 8)}….`,
  };
}

/** Submit an intent without executing it (rare — most callers want the combined flow). */
export async function basiraSubmit(
  client: BasiraClient,
  args: { action: ActionTypeName; valueSol: number; recipient?: PublicKey | null }
): Promise<IntentResult> {
  const submit = await client.submitIntent({
    action: args.action,
    valueLamports: lamports(args.valueSol),
    recipient: args.recipient ?? null,
  });
  const intent = await client.fetchIntent(submit.seq);
  const status = statusName(intent.status);
  const approved = status === "Approved";
  return {
    ok: approved,
    status: approved ? "Approved" : "Rejected",
    seq: submit.seq.toNumber(),
    intentPda: submit.intent.toBase58(),
    rejectionReason: approved ? undefined : intent.rejectionReason ?? "rejected",
    txSignatures: [submit.tx],
    summary: approved
      ? `Intent #${submit.seq.toString()} APPROVED (not yet executed).`
      : `Intent #${submit.seq.toString()} REJECTED — ${
          intent.rejectionReason ?? "no reason"
        }.`,
  };
}

/** Execute a previously approved intent by sequence number. */
export async function basiraExecute(
  client: BasiraClient,
  args: { seq: number }
): Promise<IntentResult> {
  const exec = await client.executeIntent(args.seq);
  return {
    ok: true,
    status: "Executed",
    seq: args.seq,
    intentPda: "",
    receiptPda: exec.receipt.toBase58(),
    txSignatures: [exec.tx],
    summary: `Intent #${args.seq} executed — receipt ${exec.receipt
      .toBase58()
      .slice(0, 8)}….`,
  };
}

/**
 * Replace the agent's policy rule list. Must be signed by the agent's
 * policy authority — pass that Keypair when it differs from the client's
 * wallet.
 */
export async function basiraReplacePolicy(
  client: BasiraClient,
  args: { rules: RuleArg[] },
  policyAuthority?: Keypair
): Promise<PolicyResult> {
  const tx = await client.replacePolicy({ rules: args.rules }, policyAuthority);
  const policy = await client.fetchPolicy();
  return {
    ok: true,
    tx,
    version: policy.version,
    summary: `Policy replaced — now version ${policy.version} with ${args.rules.length} rule(s).`,
  };
}

/** Read the agent's identity, policy rule list, vault balance and rate-limit state. */
export async function basiraStatus(client: BasiraClient): Promise<StatusResult> {
  const agent = await client.fetchAgentOrNull();
  if (!agent) {
    return { ok: true, exists: false, summary: "No agent registered for this wallet." };
  }
  const policy = await client.fetchPolicyOrNull();
  const decoded: DecodedRule[] = policy ? await client.fetchRules() : [];
  const vaultBalance = await client.vaultBalance();
  const windows = (agent.windows as any[])
    .filter((w) => w.active)
    .map((w) => ({ ruleIndex: w.ruleIndex as number, count: w.count as number }));

  return {
    ok: true,
    exists: true,
    agentPda: client.agentPda().toBase58(),
    authority: agent.authority.toBase58(),
    policyAuthority: (agent.policyAuthority as PublicKey).toBase58(),
    name: agent.name,
    intentCount: (agent.intentCount as BN).toNumber(),
    vaultPda: client.vaultPda().toBase58(),
    vaultBalanceSol: vaultBalance / SOL,
    policyVersion: policy ? policy.version : undefined,
    rules: decoded.map((r, i) => ({ index: i, summary: summarizeRule(r) })),
    windows,
    summary: `Agent "${agent.name}" — policy v${
      policy ? policy.version : "?"
    }, ${decoded.length} rule(s), vault ${(vaultBalance / SOL).toFixed(4)} SOL.`,
  };
}

// ── re-exports plugins commonly need ──────────────────────────────────────────

export {
  BasiraClient,
  Rule,
  validateRules,
  decodeRules,
  summarizeRule,
  rpcUrlForCluster,
} from "@basira-ai/sdk";
export type { ActionTypeName, RuleArg, DecodedRule } from "@basira-ai/sdk";
export { BN, PublicKey, Keypair } from "@basira-ai/sdk";
