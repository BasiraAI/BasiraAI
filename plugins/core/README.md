# @basira-ai/plugin-core

Framework-agnostic action functions for the **Basira** trust layer.

This is the layer the Basira framework plugins (`@basira-ai/agent-kit`,
`@basira-ai/eliza-plugin`) are built on. It wraps the `@basira-ai/sdk` client and
exposes the operations an autonomous agent performs, each returning a small,
JSON-friendly result object an LLM tool layer can pass straight back into a
model's context.

Nothing here imports a framework — the framework plugins depend on this
module, not the other way around. Use it directly if you are writing a
plugin for a framework Basira does not yet ship one for (GOAT, Rig, …).

## Install

```bash
npm install @basira-ai/plugin-core
```

## Functions

| Function | What it does |
|---|---|
| `basiraRegister` | Register an agent + set its initial policy rule list. |
| `basiraSubmitAndExecute` | Submit an intent and, if approved, execute it. The common path. |
| `basiraSubmit` | Submit an intent only (no execute). |
| `basiraExecute` | Execute a previously-approved intent by sequence number. |
| `basiraReplacePolicy` | Replace the agent's rule list (policy-authority signed). |
| `basiraStatus` | Report policy version, rule list, vault balance, rate-limit state. |

Each returns a result object with a human-readable `summary` field.

## Use

```ts
import { BasiraClient } from "@basira-ai/sdk";
import { basiraSubmitAndExecute } from "@basira-ai/plugin-core";

const result = await basiraSubmitAndExecute(client, {
  action: "Transfer",
  valueSol: 0.5,
  recipient,
});
// result.ok, result.status, result.summary, result.rejectionReason?
```
