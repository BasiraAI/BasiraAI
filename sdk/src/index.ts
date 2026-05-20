/**
 * Basira SDK — thin wrapper around the on-chain `basira` Anchor program.
 *
 * Exposes the primitives a demo or client needs:
 *   - registerAgent, submitIntent, executeIntent, replacePolicy, fundVault
 *   - Rule builders for composing rule lists
 *   - PDA derivations (agent, intent, receipt, vault, policy)
 *   - fetch helpers for agents / policies / intents / receipts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorProvider, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { Basira } from "./idl/basira";
import idl from "./idl/basira.json";

// ── Action types & helpers ────────────────────────────────────────────────────

export const ActionType = {
  Transfer: 0,
  Swap: 1,
  Stake: 2,
  ContractCall: 3,
} as const;

export type ActionTypeName = keyof typeof ActionType;

/** Anchor encodes enums as `{ variantName: {} }`. */
export const ActionVariant: Record<ActionTypeName, any> = {
  Transfer: { transfer: {} },
  Swap: { swap: {} },
  Stake: { stake: {} },
  ContractCall: { contractCall: {} },
};

/** Build an allowed-actions bitmask from a list of action names. */
export function maskFor(actions: ActionTypeName[]): number {
  return actions.reduce((acc, name) => acc | (1 << ActionType[name]), 0);
}

/** Decode an allowed-actions bitmask back into an array of action names. */
export function actionsFromMask(mask: number): ActionTypeName[] {
  const out: ActionTypeName[] = [];
  (Object.keys(ActionType) as ActionTypeName[]).forEach((k) => {
    if (mask & (1 << ActionType[k])) out.push(k);
  });
  return out;
}

/** Status helpers — intent / receipt status names. */
export type IntentStatusName = "Pending" | "Approved" | "Rejected" | "Executed";

export function statusName(status: any): IntentStatusName {
  const k = Object.keys(status)[0];
  return (k.charAt(0).toUpperCase() + k.slice(1)) as IntentStatusName;
}

/** Limits enforced both client-side and on-chain. */
export const MAX_RULES = 16;
export const MAX_RATE_WINDOWS = 4;

/** Known program error names — useful for clients that want to detect specific failures. */
export const BasiraErrorName = {
  IntentNotApproved: "IntentNotApproved",
  IntentAlreadyFinalised: "IntentAlreadyFinalised",
  UnauthorizedPolicyUpdate: "UnauthorizedPolicyUpdate",
  UnsupportedActionCpi: "UnsupportedActionCpi",
  RecipientRequired: "RecipientRequired",
  RecipientMismatch: "RecipientMismatch",
  EmptyPolicy: "EmptyPolicy",
  TooManyRules: "TooManyRules",
  TooManyRateWindows: "TooManyRateWindows",
  NameTooLong: "NameTooLong",
} as const;

// ── Rule builders ─────────────────────────────────────────────────────────────

/**
 * Anchor-encoded rule variant: `{ maxValue: { lamports: BN } }`, etc.
 * Use the `Rule` helpers below instead of constructing these by hand.
 */
export type RuleArg =
  | { maxValue: { lamports: BN } }
  | { allowedActions: { mask: number } }
  | { ratePerWindow: { windowSeconds: BN; max: number } };

/** Friendlier shape returned by `decodeRules` — easy to render in a UI. */
export type DecodedRule =
  | { type: "MaxValue"; lamports: BN; lamportsSol: number }
  | { type: "AllowedActions"; mask: number; actions: ActionTypeName[] }
  | { type: "RatePerWindow"; windowSeconds: number; max: number };

export const Rule = {
  maxValue: (lamports: BN | number): RuleArg => ({
    maxValue: { lamports: new BN(lamports) },
  }),
  allowedActions: (actions: ActionTypeName[] | number): RuleArg => ({
    allowedActions: {
      mask: typeof actions === "number" ? actions : maskFor(actions),
    },
  }),
  ratePerWindow: (windowSeconds: BN | number, max: number): RuleArg => ({
    ratePerWindow: { windowSeconds: new BN(windowSeconds), max },
  }),
};

const SOL_LAMPORTS = 1_000_000_000;

/** Convert the on-chain rule shape into a friendly object. */
export function decodeRule(raw: any): DecodedRule {
  const key = Object.keys(raw)[0];
  const inner = raw[key];
  switch (key) {
    case "maxValue": {
      const lamports = inner.lamports as BN;
      return {
        type: "MaxValue",
        lamports,
        lamportsSol: lamports.toNumber() / SOL_LAMPORTS,
      };
    }
    case "allowedActions": {
      const mask = inner.mask as number;
      return { type: "AllowedActions", mask, actions: actionsFromMask(mask) };
    }
    case "ratePerWindow": {
      const windowSeconds = (inner.windowSeconds as BN).toNumber();
      const max = inner.max as number;
      return { type: "RatePerWindow", windowSeconds, max };
    }
    default:
      throw new Error(`unknown rule variant: ${key}`);
  }
}

export function decodeRules(raws: any[]): DecodedRule[] {
  return raws.map(decodeRule);
}

/** One-line human summary of a rule (for UI display). */
export function summarizeRule(rule: DecodedRule): string {
  switch (rule.type) {
    case "MaxValue":
      return `Max ${rule.lamportsSol.toFixed(4)} SOL per intent`;
    case "AllowedActions":
      return `Allowed actions: ${rule.actions.join(", ") || "(none)"}`;
    case "RatePerWindow":
      return `${rule.max} approved intents / ${rule.windowSeconds}s`;
  }
}

/** Client-side validation matching the on-chain rules. Throws on failure. */
export function validateRules(rules: RuleArg[]): void {
  if (rules.length === 0) throw new Error("rule list is empty");
  if (rules.length > MAX_RULES)
    throw new Error(`rule list exceeds MAX_RULES (${MAX_RULES})`);
  const rateCount = rules.filter((r) => "ratePerWindow" in r).length;
  if (rateCount > MAX_RATE_WINDOWS)
    throw new Error(
      `too many RatePerWindow rules (max ${MAX_RATE_WINDOWS})`
    );
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

export function agentPda(authority: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
    programId
  );
}

export function policyPda(agent: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), agent.toBuffer()],
    programId
  );
}

export function vaultPda(agent: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agent.toBuffer()],
    programId
  );
}

function seqBuf(seq: BN | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(seq.toString()));
  return buf;
}

export function intentPda(agent: PublicKey, seq: BN | number, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

export function receiptPda(agent: PublicKey, seq: BN | number, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

// ── Client ────────────────────────────────────────────────────────────────────

export const PROGRAM_ID = new PublicKey(
  "2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu"
);

/**
 * Construction modes:
 *
 *   - `wallet` (+ optional `connection`) → bring-your-own signer. Used by
 *     plugins that wrap a framework whose runtime already owns the wallet.
 *   - `keypair`                          → wrap a raw Keypair.
 *   - `keypairPath` / default            → load a keypair from disk
 *                                          (~/.config/solana/id.json by default).
 *
 * When `connection` is supplied it takes precedence over `rpcUrl`.
 */
export interface BasiraClientOpts {
  rpcUrl?: string;             // default: http://127.0.0.1:8899
  connection?: Connection;     // bring-your-own connection (preferred for plugins)
  wallet?: anchor.Wallet;      // bring-your-own signer (preferred for plugins)
  keypairPath?: string;        // default: ~/.config/solana/id.json
  keypair?: Keypair;           // overrides keypairPath
}

export interface RegisterAgentArgs {
  name: string;
  rules: RuleArg[];
  /** Separate signer for policy updates. Defaults to the agent's authority. */
  policyAuthority?: PublicKey | null;
}

export interface SubmitIntentArgs {
  action: ActionTypeName;
  valueLamports: BN | number;
  /** Required for Transfer; ignored otherwise. */
  recipient?: PublicKey | null;
}

export interface ReplacePolicyArgs {
  rules: RuleArg[];
}

export class BasiraClient {
  readonly connection: Connection;
  readonly wallet: anchor.Wallet;
  readonly provider: AnchorProvider;
  readonly program: Program<Basira>;
  readonly programId: PublicKey;

  constructor(opts: BasiraClientOpts = {}) {
    this.connection =
      opts.connection ??
      new Connection(opts.rpcUrl ?? "http://127.0.0.1:8899", "confirmed");

    if (opts.wallet) {
      this.wallet = opts.wallet;
    } else {
      const kp =
        opts.keypair ??
        loadKeypair(opts.keypairPath ?? defaultKeypairPath());
      this.wallet = new anchor.Wallet(kp);
    }

    this.provider = new AnchorProvider(this.connection, this.wallet, {
      commitment: "confirmed",
    });
    this.program = new Program<Basira>(idl as Idl as Basira, this.provider);
    this.programId = this.program.programId;
  }

  /**
   * Construct a client from a framework-supplied wallet + connection.
   * Used by the SAK / Eliza plugins so the agent's existing signer drives
   * Basira instructions.
   */
  static fromWallet(wallet: anchor.Wallet, connection: Connection): BasiraClient {
    return new BasiraClient({ wallet, connection });
  }

  authority(): PublicKey {
    return this.wallet.publicKey;
  }

  agentPda(authority: PublicKey = this.authority()) {
    return agentPda(authority, this.programId)[0];
  }

  policyPda(agent: PublicKey = this.agentPda()) {
    return policyPda(agent, this.programId)[0];
  }

  vaultPda(agent: PublicKey = this.agentPda()) {
    return vaultPda(agent, this.programId)[0];
  }

  // ── instructions ──────────────────────────────────────────────────────────

  async registerAgent(args: RegisterAgentArgs): Promise<string> {
    validateRules(args.rules);
    return this.program.methods
      .registerAgent(
        args.name,
        args.rules as any,
        args.policyAuthority ?? null
      )
      .accounts({ authority: this.authority() })
      .rpc();
  }

  async submitIntent(
    args: SubmitIntentArgs
  ): Promise<{ tx: string; intent: PublicKey; seq: BN }> {
    if (args.action === "Transfer" && !args.recipient) {
      throw new Error("submitIntent: Transfer intents require a recipient");
    }
    const agent = this.agentPda();
    const agentAccount = await this.program.account.agentAccount.fetch(agent);
    const seq = agentAccount.intentCount as BN;
    const [intent] = intentPda(agent, seq, this.programId);

    const tx = await this.program.methods
      .submitIntent(
        ActionVariant[args.action],
        new BN(args.valueLamports),
        args.recipient ?? null
      )
      .accounts({ authority: this.authority() })
      .rpc();

    return { tx, intent, seq };
  }

  /**
   * Execute an approved intent. The recipient is looked up from the on-chain
   * intent if not provided, so callers usually just pass `seq`.
   */
  async executeIntent(
    seq: BN | number,
    recipient?: PublicKey
  ): Promise<{ tx: string; receipt: PublicKey }> {
    const agent = this.agentPda();
    const [intent] = intentPda(agent, seq, this.programId);
    const [receipt] = receiptPda(agent, seq, this.programId);
    const vault = this.vaultPda(agent);

    let to = recipient;
    if (!to) {
      const intentAcc = await this.program.account.intentRequest.fetch(intent);
      to = intentAcc.recipient as PublicKey;
    }

    const tx = await this.program.methods
      .executeIntent()
      .accountsPartial({
        intentRequest: intent,
        agent,
        agentAccount: agent,
        vault,
        recipient: to,
        executionReceipt: receipt,
        authority: this.authority(),
      })
      .rpc();

    return { tx, receipt };
  }

  /**
   * Replace the agent's rule list. Must be signed by the agent's
   * `policy_authority`. Pass that keypair when it differs from this client's
   * wallet.
   */
  async replacePolicy(
    args: ReplacePolicyArgs,
    policyAuthority?: Keypair
  ): Promise<string> {
    validateRules(args.rules);
    const agent = this.agentPda();
    const policy = this.policyPda(agent);
    const signerKey = policyAuthority?.publicKey ?? this.authority();
    const builder = this.program.methods
      .replacePolicy(args.rules as any)
      .accountsPartial({
        agentAccount: agent,
        policyAccount: policy,
        policyAuthority: signerKey,
      });

    if (policyAuthority) {
      return builder.signers([policyAuthority]).rpc();
    }
    return builder.rpc();
  }

  /** Fund the agent's vault PDA with `lamports` from the wallet. */
  async fundVault(lamports: BN | number): Promise<string> {
    const vault = this.vaultPda();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.authority(),
        toPubkey: vault,
        lamports: BigInt(new BN(lamports).toString()),
      })
    );
    return this.provider.sendAndConfirm(tx);
  }

  async vaultBalance(agent: PublicKey = this.agentPda()): Promise<number> {
    return this.connection.getBalance(this.vaultPda(agent));
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async fetchAgent(authority: PublicKey = this.authority()) {
    return this.program.account.agentAccount.fetch(this.agentPda(authority));
  }

  async fetchAgentOrNull(authority: PublicKey = this.authority()) {
    try {
      return await this.fetchAgent(authority);
    } catch {
      return null;
    }
  }

  async fetchPolicy(agent: PublicKey = this.agentPda()) {
    return this.program.account.policyAccount.fetch(this.policyPda(agent));
  }

  async fetchPolicyOrNull(agent: PublicKey = this.agentPda()) {
    try {
      return await this.fetchPolicy(agent);
    } catch {
      return null;
    }
  }

  /** Convenience: return decoded rule list. */
  async fetchRules(agent: PublicKey = this.agentPda()): Promise<DecodedRule[]> {
    const policy = await this.fetchPolicy(agent);
    return decodeRules(policy.rules as any[]);
  }

  async fetchIntent(seq: BN | number, agent?: PublicKey) {
    const [pda] = intentPda(agent ?? this.agentPda(), seq, this.programId);
    return this.program.account.intentRequest.fetch(pda);
  }

  async fetchReceipt(seq: BN | number, agent?: PublicKey) {
    const [pda] = receiptPda(agent ?? this.agentPda(), seq, this.programId);
    return this.program.account.executionReceipt.fetch(pda);
  }

  async listIntents(agent?: PublicKey) {
    const a = agent ?? this.agentPda();
    const all = await this.program.account.intentRequest.all([
      { memcmp: { offset: 8, bytes: a.toBase58() } },
    ]);
    return all
      .map((x) => ({ pubkey: x.publicKey, account: x.account }))
      .sort((l, r) =>
        (l.account.seq as BN).cmp(r.account.seq as BN)
      );
  }

  async listReceipts(agent?: PublicKey) {
    const a = agent ?? this.agentPda();
    const all = await this.program.account.executionReceipt.all([
      { memcmp: { offset: 8, bytes: a.toBase58() } },
    ]);
    return all
      .map((x) => ({ pubkey: x.publicKey, account: x.account }))
      .sort((l, r) =>
        (l.account.intentSeq as BN).cmp(r.account.intentSeq as BN)
      );
  }
}

// ── keypair loading ───────────────────────────────────────────────────────────

export function defaultKeypairPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".config", "solana", "id.json");
}

export function loadKeypair(filepath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function rpcUrlForCluster(
  cluster: "localnet" | "devnet" | "mainnet-beta"
): string {
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

// ── re-exports ────────────────────────────────────────────────────────────────

export { BN, PublicKey, Keypair };
export type { Basira };
