# @basira-ai/sdk

TypeScript SDK for the **Basira** on-chain trust layer — an Anchor program
on Solana that gives autonomous agents a policy-gated, receipted execution
path.

The program is **live on devnet** at
`2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu`.

## Install

```bash
npm install @basira-ai/sdk
```

## What it does

Basira lets an agent author attach an on-chain **rule list** to an agent.
Before the agent moves value, every action is submitted as an *intent* and
checked against the rule list on-chain — approved intents execute and write
an immutable receipt; rejected intents name the failing rule.

The SDK wraps that program:

- `BasiraClient` — register agents, submit/execute intents, replace policies
- `Rule` builders — compose a rule list (`MaxValue`, `AllowedActions`, `RatePerWindow`)
- PDA derivations — `agentPda`, `policyPda`, `vaultPda`, `intentPda`, `receiptPda`
- decode helpers — `decodeRules`, `summarizeRule`, `validateRules`

## Use

```ts
import { BasiraClient, Rule } from "@basira-ai/sdk";

const client = new BasiraClient({ rpcUrl: "https://api.devnet.solana.com" });

await client.registerAgent("treasury-bot", [
  Rule.maxValue(1_000_000_000),            // 1 SOL per intent
  Rule.allowedActions(["Transfer"]),
  Rule.ratePerWindow(60, 5),               // 5 intents / 60s
]);
```

`BasiraClient` accepts a `keypair`, a `keypairPath`, or an external
`wallet` + `connection` (so framework plugins can bring their own signer).

## Framework plugins

Most agent authors don't use this SDK directly — they install a framework
plugin built on it:

- `@basira-ai/agent-kit` — Solana Agent Kit plugin
- `@basira-ai/eliza-plugin` — ElizaOS plugin

Both depend on `@basira-ai/plugin-core`, the framework-agnostic action layer.
