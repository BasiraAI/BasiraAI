# Basira

> An on-chain trust and policy layer for autonomous AI agents on Solana.

[![Program](https://img.shields.io/badge/devnet-2oYH…zgtu-14F195?logo=solana&logoColor=white)](https://explorer.solana.com/address/2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu?cluster=devnet)

## The problem

An autonomous agent on Solana signs every transaction with a single
embedded keypair. Nothing sits between the agent's decision and the
chain — a bad prompt, a hallucination, or a compromised model can drain a
wallet, and there is no record of *why* a transaction was allowed.

## What Basira does

Basira is an Anchor program that sits between an agent and its funds.
Before an agent moves value, the action is submitted as an **intent** and
checked, **on-chain**, against a policy the agent's owner defined. Approved
intents execute and write an **immutable receipt**; rejected intents never
touch funds and return the exact rule that stopped them.

- **Policy lives on-chain, not in the agent's code.** The agent cannot
  edit, ignore, or out-think its own policy.
- **Composable rule lists.** The owner picks rules from a closed menu and
  parameterizes each one. The same rule type can appear multiple times.
- **Real enforcement.** Transfers settle via CPI from a program-owned
  vault — the policy is the only path to the funds.
- **Auditable.** Every approved action leaves a receipt account on-chain.
- **Separate policy authority.** The key that *runs* the agent is distinct
  from the key that can *change its policy*.

## How a policy works

An owner composes a rule list when registering an agent:

```ts
[
  { type: "MaxValue",      valueSol: 1 },              // ≤ 1 SOL per intent
  { type: "AllowedActions", actions: ["Transfer"] },   // Transfer only
  { type: "RatePerWindow", windowSeconds: 60, max: 5 } // ≤ 5 intents / 60s
]
```

Every intent is evaluated against the list in order. The first rule it
violates rejects it, and the rejection names that rule's index — e.g.
`rule 0: max value exceeded`.

| Rule | Parameters | Rejects when |
|---|---|---|
| `MaxValue` | `valueSol` | the intent's value exceeds the cap |
| `AllowedActions` | `actions[]` | the intent's action is not in the set |
| `RatePerWindow` | `windowSeconds`, `max` | too many approved intents in the window |

## Using Basira

Most agents are built on a framework. Basira ships a plugin for each — drop
it in and the agent's fund movements route through the policy engine.

### Solana Agent Kit

```bash
npm install @basira-ai/agent-kit
```

```ts
import { SolanaAgentKit } from "solana-agent-kit";
import { BasiraPlugin } from "@basira-ai/agent-kit";

const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(new BasiraPlugin());

await agent.methods.basira_register(agent, {
  name: "treasury-bot",
  rules: [
    { type: "MaxValue", valueSol: 1 },
    { type: "AllowedActions", actions: ["Transfer"] },
  ],
});

const result = await agent.methods.basira_transfer(agent, {
  recipient: "9xQ…abc",
  valueSol: 0.5,
});
// result.status — "Executed" or "Rejected" (with result.rejectionReason)
```

### ElizaOS

```bash
npm install @basira-ai/eliza-plugin
```

```ts
import { basiraPlugin } from "@basira-ai/eliza-plugin";

const character = {
  name: "TreasuryBot",
  plugins: [basiraPlugin],
  settings: {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_PRIVATE_KEY: "[12,34,...]",
  },
};
```

### Direct SDK

For agents not on a supported framework:

```bash
npm install @basira-ai/sdk
```

```ts
import { BasiraClient, Rule } from "@basira-ai/sdk";

const client = new BasiraClient({ rpcUrl: "https://api.devnet.solana.com" });
await client.registerAgent("my-agent", [Rule.maxValue(1_000_000_000)]);
```

The program is already deployed to devnet, so clients need no program
deploy and no IDL file — `@basira-ai/sdk` bundles it.

> **One required step:** transfers move SOL from a program-owned **vault
> PDA**, not the wallet directly. After registering, send SOL once to the
> vault address (`basira_status` → `vaultPda`) to fund the agent.

## Packages

| Package | Description |
|---|---|
| [`@basira-ai/sdk`](./sdk) | TypeScript SDK wrapping the on-chain program. |
| [`@basira-ai/plugin-core`](./plugins/core) | Framework-agnostic action functions. |
| [`@basira-ai/agent-kit`](./plugins/solana-agent-kit) | Solana Agent Kit plugin. |
| [`@basira-ai/eliza-plugin`](./plugins/eliza) | ElizaOS plugin. |

## Running locally

Requires `anchor` 0.32+, `solana` CLI, `node` 20+, and `yarn`.

```bash
yarn install
anchor test          # builds, spins up a validator, runs the suite
```

Run the scripted end-to-end demo against a local validator:

```bash
solana-test-validator --reset          # in another terminal
anchor deploy --provider.cluster localnet
yarn demo                               # 7-step CLI walkthrough
yarn web                                # http://localhost:4000
```

Both `demo` and `web` have `:devnet` variants that run against the live
deployment instead of a local validator.

## Architecture

```
programs/basira/   Anchor program — the policy engine
sdk/               @basira-ai/sdk — TypeScript client
plugins/core/      @basira-ai/plugin-core — shared action layer
plugins/*/         @basira-ai/agent-kit, @basira-ai/eliza-plugin
demo/              scripted CLI walkthrough
web/               Express server + UI for live demoing
tests/             Anchor test suite (program + plugin integration tests)
```

## Built on

- [Solana](https://solana.com)
- [Anchor](https://anchor-lang.com)
- [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit)
- [ElizaOS](https://github.com/elizaOS/eliza)
