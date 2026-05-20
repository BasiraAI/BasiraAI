use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu");

// ── Action types an agent may attempt ────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ActionType {
    Transfer,
    Swap,
    Stake,
    ContractCall,
}

// ── Intent / receipt status ───────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum IntentStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

// ── Rule enum (the user-composed policy primitives) ──────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Rule {
    /// Reject if intent value exceeds `lamports`.
    MaxValue { lamports: u64 },
    /// Reject if the intent's action bit is not set in `mask`.
    /// (Bit 0 = Transfer, 1 = Swap, 2 = Stake, 3 = ContractCall.)
    AllowedActions { mask: u8 },
    /// Reject if more than `max` approved intents have occurred within
    /// the rolling `window_seconds` window. Tracked per rule index.
    RatePerWindow { window_seconds: i64, max: u32 },
}

// Maximum size of any single rule serialized: 1 (tag) + 8 + 4 = 13 bytes.
const MAX_RULE_SIZE: usize = 13;
const MAX_RULES: usize = 16;
const MAX_RATE_WINDOWS: usize = 4;

// ── Error codes ───────────────────────────────────────────────────────────────

#[error_code]
pub enum BasiraError {
    #[msg("Intent has not been approved")]
    IntentNotApproved,
    #[msg("Intent already finalised")]
    IntentAlreadyFinalised,
    #[msg("Signer is not the policy authority")]
    UnauthorizedPolicyUpdate,
    #[msg("Action type not yet supported for on-chain execution")]
    UnsupportedActionCpi,
    #[msg("Transfer intents require a recipient")]
    RecipientRequired,
    #[msg("Recipient account does not match the approved intent")]
    RecipientMismatch,
    #[msg("Policy rule list is empty")]
    EmptyPolicy,
    #[msg("Policy rule list exceeds the maximum allowed length")]
    TooManyRules,
    #[msg("Policy contains more RatePerWindow rules than supported")]
    TooManyRateWindows,
    #[msg("Name exceeds 32 chars")]
    NameTooLong,
}

// ── Accounts ──────────────────────────────────────────────────────────────────

/// Persistent identity record for a registered agent.
#[account]
pub struct AgentAccount {
    pub authority: Pubkey,           // signs intents + executes
    pub policy_authority: Pubkey,    // signs policy updates
    pub name: String,                // max 32 chars
    pub intent_count: u64,
    pub windows: [WindowCounter; MAX_RATE_WINDOWS], // per-RatePerWindow-rule live counters
    pub vault_bump: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub struct WindowCounter {
    pub start_ts: i64,
    pub count: u32,
    pub rule_index: u8,
    pub active: bool, // false = unused slot
}

/// Per-agent policy account holding the user-composed rule list.
#[account]
pub struct PolicyAccount {
    pub agent: Pubkey,
    pub version: u32,    // monotonic; bumped on each replace_policy
    pub rules: Vec<Rule>,
    pub bump: u8,
}

/// A single proposed action, evaluated against the agent's policy.
#[account]
pub struct IntentRequest {
    pub agent: Pubkey,
    pub action_type: ActionType,
    pub value_lamports: u64,
    pub recipient: Pubkey,                // Pubkey::default() if not applicable
    pub status: IntentStatus,
    pub rejection_reason: Option<String>, // set on Rejected
    pub submitted_at: i64,
    pub finalised_at: Option<i64>,
    pub seq: u64,                         // monotonic per agent
    pub bump: u8,
}

/// Immutable onchain proof that an intent was executed.
#[account]
pub struct ExecutionReceipt {
    pub agent: Pubkey,
    pub intent_seq: u64,
    pub action_type: ActionType,
    pub value_lamports: u64,
    pub recipient: Pubkey,
    pub executed_at: i64,
    pub bump: u8,
}

// ── Space helpers ─────────────────────────────────────────────────────────────

// WindowCounter: i64(8) + u32(4) + u8(1) + bool(1) = 14
const WINDOW_COUNTER_SIZE: usize = 14;

impl AgentAccount {
    // discriminator(8) + authority(32) + policy_authority(32) + name(4+32)
    // + intent_count(8) + windows(4*14=56) + vault_bump(1) + bump(1)
    pub const SPACE: usize = 8 + 32 + 32 + (4 + 32) + 8 + (MAX_RATE_WINDOWS * WINDOW_COUNTER_SIZE) + 1 + 1;
}

impl PolicyAccount {
    // discriminator(8) + agent(32) + version(4) + vec_len(4)
    // + MAX_RULES * MAX_RULE_SIZE + bump(1)
    pub const SPACE: usize = 8 + 32 + 4 + 4 + (MAX_RULES * MAX_RULE_SIZE) + 1;
}

impl IntentRequest {
    // discriminator(8) + agent(32) + action(1) + value(8) + recipient(32)
    // + status(1) + option<string>(1 + 4 + 96) + submitted_at(8)
    // + option<i64>(1+8) + seq(8) + bump(1)
    pub const SPACE: usize =
        8 + 32 + 1 + 8 + 32 + 1 + (1 + 4 + 96) + 8 + (1 + 8) + 8 + 1;
}

impl ExecutionReceipt {
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8 + 32 + 8 + 1;
}

// ── Rule helpers ──────────────────────────────────────────────────────────────

fn validate_rules(rules: &Vec<Rule>) -> Result<()> {
    require!(!rules.is_empty(), BasiraError::EmptyPolicy);
    require!(rules.len() <= MAX_RULES, BasiraError::TooManyRules);
    let rate_count = rules
        .iter()
        .filter(|r| matches!(r, Rule::RatePerWindow { .. }))
        .count();
    require!(rate_count <= MAX_RATE_WINDOWS, BasiraError::TooManyRateWindows);
    Ok(())
}

/// Initialize the agent's per-rule rate-limit window counters from a rule list.
fn init_windows(rules: &Vec<Rule>, now: i64) -> [WindowCounter; MAX_RATE_WINDOWS] {
    let mut windows: [WindowCounter; MAX_RATE_WINDOWS] = Default::default();
    let mut slot = 0usize;
    for (i, rule) in rules.iter().enumerate() {
        if matches!(rule, Rule::RatePerWindow { .. }) && slot < MAX_RATE_WINDOWS {
            windows[slot] = WindowCounter {
                start_ts: now,
                count: 0,
                rule_index: i as u8,
                active: true,
            };
            slot += 1;
        }
    }
    windows
}

fn action_bit(action: &ActionType) -> u8 {
    match action {
        ActionType::Transfer => 0,
        ActionType::Swap => 1,
        ActionType::Stake => 2,
        ActionType::ContractCall => 3,
    }
}

enum RuleDecision {
    Pass,
    Reject(&'static str),
}

/// Evaluate a single rule against an intent. May mutate the agent's window
/// counters if the rule is RatePerWindow.
fn evaluate_rule(
    rule: &Rule,
    rule_index: usize,
    intent_value: u64,
    intent_action: &ActionType,
    windows: &mut [WindowCounter; MAX_RATE_WINDOWS],
    now: i64,
) -> RuleDecision {
    match rule {
        Rule::MaxValue { lamports } => {
            if intent_value > *lamports {
                RuleDecision::Reject("max value exceeded")
            } else {
                RuleDecision::Pass
            }
        }
        Rule::AllowedActions { mask } => {
            let bit = action_bit(intent_action);
            if mask & (1 << bit) == 0 {
                RuleDecision::Reject("action not permitted")
            } else {
                RuleDecision::Pass
            }
        }
        Rule::RatePerWindow { window_seconds, max } => {
            let slot = windows
                .iter_mut()
                .find(|w| w.active && w.rule_index as usize == rule_index);
            let Some(counter) = slot else {
                // Defensive: should never happen if validation + init_windows ran.
                return RuleDecision::Reject("rate window state missing");
            };
            if *window_seconds > 0 && now.saturating_sub(counter.start_ts) >= *window_seconds {
                counter.start_ts = now;
                counter.count = 0;
            }
            if counter.count >= *max {
                return RuleDecision::Reject("rate limit exceeded");
            }
            counter.count += 1;
            RuleDecision::Pass
        }
    }
}

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod basira {
    use super::*;

    /// Register a new agent and its PolicyAccount with an initial rule list.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        rules: Vec<Rule>,
        policy_authority: Option<Pubkey>,
    ) -> Result<()> {
        require!(name.len() <= 32, BasiraError::NameTooLong);
        validate_rules(&rules)?;

        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent_account;
        agent.authority = ctx.accounts.authority.key();
        agent.policy_authority = policy_authority.unwrap_or_else(|| ctx.accounts.authority.key());
        agent.name = name;
        agent.intent_count = 0;
        agent.windows = init_windows(&rules, clock.unix_timestamp);
        agent.vault_bump = ctx.bumps.vault;
        agent.bump = ctx.bumps.agent_account;

        let policy = &mut ctx.accounts.policy_account;
        policy.agent = agent.key();
        policy.version = 0;
        policy.rules = rules;
        policy.bump = ctx.bumps.policy_account;

        emit!(AgentRegistered {
            agent: agent.key(),
            authority: agent.authority,
            policy_authority: agent.policy_authority,
            policy_version: policy.version,
            n_rules: policy.rules.len() as u8,
        });

        Ok(())
    }

    /// Submit an intent. The interpreter iterates the agent's rule list;
    /// the first failing rule rejects with `rule N: <reason>`.
    pub fn submit_intent(
        ctx: Context<SubmitIntent>,
        action_type: ActionType,
        value_lamports: u64,
        recipient: Option<Pubkey>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent_account;
        let policy = &ctx.accounts.policy_account;
        let intent = &mut ctx.accounts.intent_request;
        let clock = Clock::get()?;

        let seq = agent.intent_count;
        agent.intent_count += 1;

        intent.agent = agent.key();
        intent.action_type = action_type.clone();
        intent.value_lamports = value_lamports;
        intent.recipient = recipient.unwrap_or_default();
        intent.submitted_at = clock.unix_timestamp;
        intent.finalised_at = None;
        intent.seq = seq;
        intent.bump = ctx.bumps.intent_request;

        // Structural check: Transfer must name a recipient. Not user-controlled.
        if matches!(action_type, ActionType::Transfer) && intent.recipient == Pubkey::default() {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some("transfer requires recipient".to_string());
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        // Interpreter loop. NB: `RatePerWindow` mutates `agent.windows`.
        // We collect a decision first so we can record the rule index in the message.
        let mut rejection: Option<(usize, &'static str)> = None;
        for (i, rule) in policy.rules.iter().enumerate() {
            match evaluate_rule(
                rule,
                i,
                value_lamports,
                &action_type,
                &mut agent.windows,
                clock.unix_timestamp,
            ) {
                RuleDecision::Pass => {}
                RuleDecision::Reject(reason) => {
                    rejection = Some((i, reason));
                    break;
                }
            }
        }

        if let Some((i, reason)) = rejection {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some(format!("rule {}: {}", i, reason));
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        intent.status = IntentStatus::Approved;
        intent.rejection_reason = None;
        emit!(IntentEvaluated { agent: agent.key(), seq, approved: true });

        Ok(())
    }

    /// Execute an approved intent. For Transfer, performs a real SystemProgram
    /// CPI from the agent's vault PDA to the approved recipient. The receipt
    /// is only written if the inner action succeeds.
    pub fn execute_intent(ctx: Context<ExecuteIntent>) -> Result<()> {
        let intent = &mut ctx.accounts.intent_request;
        require!(intent.status == IntentStatus::Approved, BasiraError::IntentNotApproved);

        match intent.action_type {
            ActionType::Transfer => {
                require!(
                    ctx.accounts.recipient.key() == intent.recipient,
                    BasiraError::RecipientMismatch
                );

                let agent_key = ctx.accounts.agent_account.key();
                let vault_bump = ctx.accounts.agent_account.vault_bump;
                let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[vault_bump]];
                let signer_seeds: &[&[&[u8]]] = &[seeds];

                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                    },
                    signer_seeds,
                );
                system_program::transfer(cpi_ctx, intent.value_lamports)?;
            }
            _ => return err!(BasiraError::UnsupportedActionCpi),
        }

        let clock = Clock::get()?;
        intent.status = IntentStatus::Executed;
        intent.finalised_at = Some(clock.unix_timestamp);

        let receipt = &mut ctx.accounts.execution_receipt;
        receipt.agent = intent.agent;
        receipt.intent_seq = intent.seq;
        receipt.action_type = intent.action_type.clone();
        receipt.value_lamports = intent.value_lamports;
        receipt.recipient = intent.recipient;
        receipt.executed_at = clock.unix_timestamp;
        receipt.bump = ctx.bumps.execution_receipt;

        emit!(ReceiptWritten {
            agent: receipt.agent,
            intent_seq: receipt.intent_seq,
            value_lamports: receipt.value_lamports,
            recipient: receipt.recipient,
            executed_at: receipt.executed_at,
        });

        Ok(())
    }

    /// Replace the agent's rule list. Must be signed by `policy_authority`.
    /// Resets all rate-limit window counters (a fresh policy applies from `now`).
    pub fn replace_policy(
        ctx: Context<ReplacePolicy>,
        rules: Vec<Rule>,
    ) -> Result<()> {
        validate_rules(&rules)?;

        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent_account;
        require!(
            ctx.accounts.policy_authority.key() == agent.policy_authority,
            BasiraError::UnauthorizedPolicyUpdate
        );

        let policy = &mut ctx.accounts.policy_account;
        policy.rules = rules;
        policy.version = policy.version.saturating_add(1);

        agent.windows = init_windows(&policy.rules, clock.unix_timestamp);

        emit!(PolicyReplaced {
            agent: agent.key(),
            version: policy.version,
            n_rules: policy.rules.len() as u8,
        });

        Ok(())
    }
}

// ── Contexts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentAccount::SPACE,
        seeds = [b"agent", authority.key().as_ref()],
        bump,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    #[account(
        init,
        payer = authority,
        space = PolicyAccount::SPACE,
        seeds = [b"policy", agent_account.key().as_ref()],
        bump,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    /// CHECK: system-owned PDA used as the agent's lamport vault. Address is
    /// derived from `agent_account` here so we can capture and store its bump
    /// at registration time; it holds no data.
    #[account(
        seeds = [b"vault", agent_account.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitIntent<'info> {
    #[account(
        mut,
        seeds = [b"agent", authority.key().as_ref()],
        bump = agent_account.bump,
        has_one = authority,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    #[account(
        seeds = [b"policy", agent_account.key().as_ref()],
        bump = policy_account.bump,
        constraint = policy_account.agent == agent_account.key(),
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    #[account(
        init,
        payer = authority,
        space = IntentRequest::SPACE,
        seeds = [b"intent", agent_account.key().as_ref(), &agent_account.intent_count.to_le_bytes()],
        bump,
    )]
    pub intent_request: Account<'info, IntentRequest>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteIntent<'info> {
    #[account(
        mut,
        seeds = [b"intent", agent_account.key().as_ref(), &intent_request.seq.to_le_bytes()],
        bump = intent_request.bump,
        has_one = agent,
    )]
    pub intent_request: Account<'info, IntentRequest>,

    /// CHECK: used only as a key reference for the receipt PDA seed.
    #[account(address = intent_request.agent)]
    pub agent: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"agent", authority.key().as_ref()],
        bump = agent_account.bump,
        has_one = authority,
        constraint = agent_account.key() == intent_request.agent,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    #[account(
        mut,
        seeds = [b"vault", agent_account.key().as_ref()],
        bump = agent_account.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: recipient is verified against `intent_request.recipient` in handler.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = ExecutionReceipt::SPACE,
        seeds = [b"receipt", agent_account.key().as_ref(), &intent_request.seq.to_le_bytes()],
        bump,
    )]
    pub execution_receipt: Account<'info, ExecutionReceipt>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReplacePolicy<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent_account.authority.as_ref()],
        bump = agent_account.bump,
        has_one = policy_authority,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    #[account(
        mut,
        seeds = [b"policy", agent_account.key().as_ref()],
        bump = policy_account.bump,
        constraint = policy_account.agent == agent_account.key(),
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    pub policy_authority: Signer<'info>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct AgentRegistered {
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub policy_authority: Pubkey,
    pub policy_version: u32,
    pub n_rules: u8,
}

#[event]
pub struct IntentEvaluated {
    pub agent: Pubkey,
    pub seq: u64,
    pub approved: bool,
}

#[event]
pub struct ReceiptWritten {
    pub agent: Pubkey,
    pub intent_seq: u64,
    pub value_lamports: u64,
    pub recipient: Pubkey,
    pub executed_at: i64,
}

#[event]
pub struct PolicyReplaced {
    pub agent: Pubkey,
    pub version: u32,
    pub n_rules: u8,
}
