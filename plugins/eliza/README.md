# @basira-ai/eliza-plugin

ElizaOS plugin for the **Basira** trust layer.

Gives an ElizaOS character policy-gated, receipted on-chain execution. When
the character moves SOL it fires `BASIRA_TRANSFER`, which routes through
Basira's on-chain policy engine — every action is checked against the
agent's rule list before any value moves, and approved actions produce an
immutable on-chain receipt.

## Install

```bash
npm install @basira-ai/eliza-plugin
```

## Use

```ts
import { basiraPlugin } from "@basira-ai/eliza-plugin";

const character = {
  name: "TreasuryBot",
  plugins: [basiraPlugin],
  settings: {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_PRIVATE_KEY: "[12,34,...]"   // agent keypair, JSON byte array
  },
};
```

## Actions

| Action | What it does |
|---|---|
| `BASIRA_REGISTER` | Register the agent + set its initial policy rule list. Call once. |
| `BASIRA_TRANSFER` | Send SOL through the policy engine. Settles only if every rule passes. |
| `BASIRA_REPLACE_POLICY` | Replace the rule list (policy-authority signed). |
| `BASIRA_STATUS` | Report policy version, rule list, vault balance, rate-limit state. |

The plugin also registers a **provider** that injects the agent's live
policy into the model's context, so the character always reasons with its
current rules in view.

## Rule descriptors

```ts
[
  { type: "MaxValue", valueSol: 1 },
  { type: "AllowedActions", actions: ["Transfer"] },
  { type: "RatePerWindow", windowSeconds: 60, max: 5 },
]
```

The same rule type may appear multiple times. A transfer is rejected by the
first rule it violates, and the rejection names that rule's index.

## Runtime settings

| Setting | Purpose |
|---|---|
| `SOLANA_RPC_URL` | RPC endpoint (default `http://127.0.0.1:8899`). |
| `SOLANA_PRIVATE_KEY` | The agent's keypair as a JSON byte array. |

## Example

`examples/treasury-character.json` is a reference character wiring the
plugin. `tests/plugins/eliza.test.ts` shows a runnable end-to-end wire-up
against an ephemeral validator.
