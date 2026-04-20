# BasiraAI

> Trust infrastructure for autonomous agent execution on Solana.

## What is Basira?

AI agents on Solana can already transact. What they cannot do is prove 
they should have.

Basira is the trust and policy enforcement layer that sits between an 
agent receiving a task and an agent executing it. Every action is 
validated against a configurable policy engine before it touches the 
chain. Every execution produces an immutable onchain receipt that proves 
what happened, when, and why it was allowed.

No more black-box agent decisions. No more unauditable autonomous 
transactions. Just provable, policy-gated execution.

## The Problem

Current agent deployments on Solana have no enforcement layer between 
intent and execution:

- Agents execute with full wallet access and no policy guardrails
- There is no onchain record of why an action was approved
- High-risk actions — treasury moves, contract interactions, 
  cross-program calls — are indistinguishable from routine ones

Autonex introduced static policy rules. Static rules only catch what 
you anticipated. Basira handles everything else.

## How It Works
Every step is logged. Every decision is verifiable. 
No execution without a valid trust signal.

## Architecture

| Layer | Purpose |
|---|---|
| Policy Engine | Configurable onchain rules — value thresholds, program whitelists, action types |
| Trust Validator | Evaluates agent actions against active policies |
| Attestation Layer | Writes machine-readable approval/rejection onchain |
| Guard Program | Blocks execution unless a valid attestation exists |
| SDK | TypeScript + Rust integration for agent developers |

## Deployed Program

| Network | Address |
|---|---|
| Devnet | `coming soon` |
| Mainnet | `coming soon` |

## Repo Structure## Quick Start

```bash
git clone https://github.com/BasiraAI/BasiraAI
cd BasiraAI
npm install
```

Demo scripts (devnet):
```bash
# Scenario 1 — high-value action gets approved
npx ts-node scripts/demo-approve.ts

# Scenario 2 — risky action gets blocked  
npx ts-node scripts/demo-block.ts
```

## Built On

- [Solana](https://solana.com)
- [Anchor](https://anchor-lang.com)
- [Solana Attestation Service](https://attest.solana.com)
- [Solana Agent Registry](https://solana.com/agent-registry)

## Status

Active development — Solana Frontier Hackathon 2026 (April 6 – May 11)

---

Built by the Basira team.
