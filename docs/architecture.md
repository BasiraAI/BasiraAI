# Basira Architecture

## Overview

Basira is trust and policy enforcement infrastructure for autonomous 
agent execution on Solana. It sits between an agent receiving a task 
and an agent executing it.

## Where Basira Sits
Agent receives task
↓
Basira Policy Engine evaluates the action
↓
Action approved or blocked
↓
Onchain attestation written
↓
Execution proceeds — or doesn't
## Core Accounts

| Account | Purpose |
|---|---|
| AgentAccount | Agent identity, metadata, stake balance |
| StakeAccount | Bonded stake for accountability |
| ReputationAccount | Onchain execution history and scoring |
| SlashingRecord | Misbehaviour log |
| PolicyPrimitive | Single composable rule |
| PolicySet | Graph of primitives with inheritance |
| SharedPolicyLibrary | Reusable policies across agents |
| IntentRequest | Proposed agent action pending evaluation |
| ExecutionReceipt | Immutable onchain proof of execution |

## Execution Flow

### Happy Path
1. Agent submits intent
2. Policy engine loads active PolicySet
3. All primitives evaluate the intent
4. Intent passes — transaction constructed
5. State-snapshot simulation runs
6. Transaction submitted to Solana
7. ExecutionReceipt written onchain

### Rejection Path
1. Agent submits intent
2. Policy engine evaluates
3. One or more primitives fail
4. Intent rejected — PolicyRejectionError returned
5. Receipt written with rejection details

## Ecosystem Integrations

- **Solana Agent Registry** — AgentAccount reads and writes to 
  ecosystem-level agent identity
- **Solana Attestation Service** — ExecutionReceipts emit SAS-format 
  attestations
- **x402** — Agent payment intents gated through Basira policy engine
