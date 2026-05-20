# @basira-ai/agent-kit

Solana Agent Kit plugin for the **Basira** trust layer.

Basira sits between an autonomous agent and the chain: every action is
evaluated against the agent's on-chain policy *before* any value moves, and
every approved action produces an immutable on-chain receipt. This plugin
exposes that flow to a Solana Agent Kit agent.

## Install

```bash
npm install @basira-ai/agent-kit
```

## Use

```ts
import { SolanaAgentKit } from "solana-agent-kit";
import { BasiraPlugin } from "@basira-ai/agent-kit";

const agent = new SolanaAgentKit(wallet, rpcUrl, config)
  .use(new BasiraPlugin());
```

The plugin registers four LLM-callable tools:

| Tool | What it does |
|---|---|
| `basira_register` | Register the agent + set its initial policy rule list. Call once. |
| `basira_transfer` | Send SOL through the policy engine. Moves real lamports only if every rule passes. |
| `basira_replace_policy` | Replace the rule list (policy-authority signed). |
| `basira_status` | Read policy version, rule list, vault balance, rate-limit state. |

## Rule descriptors

Policies are composed from a fixed menu of rule types; you pick and
parameterize them:

```ts
[
  { type: "MaxValue", valueSol: 1 },
  { type: "AllowedActions", actions: ["Transfer"] },
  { type: "RatePerWindow", windowSeconds: 60, max: 5 },
]
```

The same rule type may appear multiple times (e.g. two `RatePerWindow`
rules with different windows). A transfer is rejected by the first rule it
violates; the rejection names that rule's index.

## Programmatic access

Skip the LLM tool layer with the `.basira` accessor:

```ts
const plugin = new BasiraPlugin();
agent.use(plugin);

await plugin.basira.register({ name: "treasury-bot", rules: [...] });
const r = await plugin.basira.transfer({ recipient, valueSol: 0.5 });
// r.status === "Executed" | "Rejected", r.summary, r.receiptPda, ...
```

## Example

`examples/treasury-bot.ts` runs the full flow against a validator —
register, fund the vault, an approved transfer, a rejected over-limit
transfer. Set `BASIRA_RPC` to point it at devnet.
