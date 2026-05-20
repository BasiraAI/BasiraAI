/**
 * @basira-ai/agent-kit — Solana Agent Kit plugin for the Basira trust layer.
 *
 * Drops Basira's policy-gated execution into a Solana Agent Kit agent.
 * Instead of signing transfers directly, the agent calls `basira_transfer`,
 * which routes through Basira's on-chain policy engine: every action is
 * evaluated against the agent's rule list before any lamports move, and
 * approved actions produce an immutable on-chain receipt.
 *
 * Usage:
 *
 *   import { SolanaAgentKit } from "solana-agent-kit";
 *   import { BasiraPlugin } from "@basira-ai/agent-kit";
 *
 *   const agent = new SolanaAgentKit(wallet, rpcUrl, cfg)
 *     .use(new BasiraPlugin());
 *
 *   // exposed to the agent's LLM tool surface:
 *   //   basira_register, basira_transfer, basira_replace_policy, basira_status
 */

import * as anchor from "@coral-xyz/anchor";
import { z } from "zod";
import type { Plugin, Action, SolanaAgentKit } from "solana-agent-kit";
import {
  BasiraClient,
  Rule,
  RuleArg,
  PublicKey,
  basiraRegister,
  basiraSubmitAndExecute,
  basiraReplacePolicy,
  basiraStatus,
} from "@basira-ai/plugin-core";

export interface BasiraPluginOpts {
  /** Optional RPC override; by default the agent's own connection is used. */
  rpcUrl?: string;
}

/** Zod schema for a single rule descriptor accepted by the register/replace actions. */
const ruleDescriptorSchema = z.union([
  z.object({ type: z.literal("MaxValue"), valueSol: z.number() }),
  z.object({ type: z.literal("AllowedActions"), actions: z.array(z.string()) }),
  z.object({
    type: z.literal("RatePerWindow"),
    windowSeconds: z.number(),
    max: z.number(),
  }),
]);

/**
 * Translate a friendly rule descriptor (the shape an LLM or agent author
 * passes) into the SDK's Anchor-encoded RuleArg.
 *
 *   { type: "MaxValue", valueSol: 2 }
 *   { type: "AllowedActions", actions: ["Transfer"] }
 *   { type: "RatePerWindow", windowSeconds: 60, max: 3 }
 */
export function ruleFromDescriptor(d: any): RuleArg {
  switch (d?.type) {
    case "MaxValue":
      return Rule.maxValue(Math.floor(Number(d.valueSol) * 1_000_000_000));
    case "AllowedActions":
      return Rule.allowedActions(d.actions);
    case "RatePerWindow":
      return Rule.ratePerWindow(Number(d.windowSeconds), Number(d.max));
    default:
      throw new Error(`unknown rule type: ${d?.type}`);
  }
}

export class BasiraPlugin implements Plugin {
  readonly name = "basira";
  private client!: BasiraClient;

  constructor(private opts: BasiraPluginOpts = {}) {}

  /** Called by SAK when the plugin is registered via `.use()`. */
  initialize(agent: SolanaAgentKit): void {
    // SAK's BaseWallet is structurally compatible with anchor.Wallet
    // (publicKey + signTransaction + signAllTransactions).
    this.client = new BasiraClient({
      wallet: agent.wallet as unknown as anchor.Wallet,
      connection: agent.connection,
    });
  }

  /** Direct programmatic access for agent authors who skip the LLM layer. */
  get basira() {
    return {
      register: (args: { name: string; rules: any[]; policyAuthority?: string }) =>
        basiraRegister(this.client, {
          name: args.name,
          rules: args.rules.map(ruleFromDescriptor),
          policyAuthority: args.policyAuthority
            ? new PublicKey(args.policyAuthority)
            : null,
        }),
      transfer: (args: { recipient: string; valueSol: number }) =>
        basiraSubmitAndExecute(this.client, {
          action: "Transfer",
          valueSol: args.valueSol,
          recipient: new PublicKey(args.recipient),
        }),
      replacePolicy: (args: { rules: any[] }) =>
        basiraReplacePolicy(this.client, {
          rules: args.rules.map(ruleFromDescriptor),
        }),
      status: () => basiraStatus(this.client),
    };
  }

  /**
   * `methods` is SAK's programmatic surface — `agent.methods.basira_*`.
   * Each is a thin wrapper around the `basira` accessor above.
   */
  methods = {
    basira_register: (_agent: SolanaAgentKit, input: any) =>
      this.basira.register(input),
    basira_transfer: (_agent: SolanaAgentKit, input: any) =>
      this.basira.transfer(input),
    basira_replace_policy: (_agent: SolanaAgentKit, input: any) =>
      this.basira.replacePolicy(input),
    basira_status: (_agent: SolanaAgentKit) => this.basira.status(),
  };

  /** LLM-callable tool descriptors registered with the agent. */
  actions: Action[] = [
    {
      name: "basira_register",
      similes: ["BASIRA_REGISTER", "REGISTER_BASIRA_AGENT", "SET_BASIRA_POLICY"],
      description:
        "Register this agent with Basira and set its initial on-chain policy. " +
        "`rules` is a list of rule descriptors: " +
        '{type:"MaxValue",valueSol:N}, {type:"AllowedActions",actions:["Transfer","Swap"]}, ' +
        '{type:"RatePerWindow",windowSeconds:N,max:N}. Call this once before basira_transfer.',
      examples: [
        [
          {
            input: {
              name: "treasury-bot",
              rules: [{ type: "MaxValue", valueSol: 1 }],
            },
            output: { ok: true, status: "Registered" },
            explanation:
              "Register a treasury agent with a 1 SOL per-intent cap.",
          },
        ],
      ],
      schema: z.object({
        name: z.string(),
        rules: z.array(ruleDescriptorSchema),
        policyAuthority: z.string().optional(),
      }),
      handler: async (_agent, input) =>
        basiraRegister(this.client, {
          name: input.name,
          rules: (input.rules ?? []).map(ruleFromDescriptor),
          policyAuthority: input.policyAuthority
            ? new PublicKey(input.policyAuthority)
            : null,
        }),
    },
    {
      name: "basira_transfer",
      similes: ["BASIRA_TRANSFER", "POLICY_TRANSFER", "GUARDED_TRANSFER"],
      description:
        "Send SOL through Basira's policy-gated trust layer. Real lamports " +
        "move from the agent's vault to `recipient` only if every policy rule " +
        "passes; a rejected transfer returns an on-chain reason naming the " +
        "failing rule. Inputs: recipient (base58 pubkey), valueSol (number).",
      examples: [
        [
          {
            input: { recipient: "9xQ…abc", valueSol: 0.5 },
            output: { ok: true, status: "Executed" },
            explanation:
              "Move 0.5 SOL through the policy engine; it settles because it is within policy.",
          },
        ],
      ],
      schema: z.object({
        recipient: z.string(),
        valueSol: z.number(),
      }),
      handler: async (_agent, input) =>
        basiraSubmitAndExecute(this.client, {
          action: "Transfer",
          valueSol: Number(input.valueSol),
          recipient: new PublicKey(input.recipient),
        }),
    },
    {
      name: "basira_replace_policy",
      similes: ["BASIRA_REPLACE_POLICY", "UPDATE_BASIRA_POLICY"],
      description:
        "Replace the agent's Basira policy with a new rule list. Must be " +
        "signed by the agent's policy authority. Inputs: rules (list of rule " +
        "descriptors, same shape as basira_register).",
      examples: [
        [
          {
            input: { rules: [{ type: "MaxValue", valueSol: 0.5 }] },
            output: { ok: true },
            explanation: "Tighten the per-intent cap to 0.5 SOL.",
          },
        ],
      ],
      schema: z.object({ rules: z.array(ruleDescriptorSchema) }),
      handler: async (_agent, input) =>
        basiraReplacePolicy(this.client, {
          rules: (input.rules ?? []).map(ruleFromDescriptor),
        }),
    },
    {
      name: "basira_status",
      similes: ["BASIRA_STATUS", "CHECK_BASIRA_POLICY"],
      description:
        "Read the agent's Basira state: policy version, the active rule list " +
        "with human-readable summaries, vault balance, and rate-limit window " +
        "counters. Takes no inputs.",
      examples: [
        [
          {
            input: {},
            output: { exists: true, policyVersion: 0 },
            explanation: "Report the agent's current on-chain policy.",
          },
        ],
      ],
      schema: z.object({}),
      handler: async () => basiraStatus(this.client),
    },
  ];
}

export default BasiraPlugin;
export { Rule } from "@basira-ai/plugin-core";
