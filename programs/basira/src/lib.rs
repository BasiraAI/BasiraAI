use anchor_lang::prelude::*;

declare_id!("8xDqU6M7EekMiwjQZY8KyJTzezkfmgf9QiL9eXHZJZWX");

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

// ── Error codes ───────────────────────────────────────────────────────────────

#[error_code]
pub enum BasiraError {
    #[msg("Value exceeds policy maximum")]
    ValueExceedsLimit,
    #[msg("Action type not permitted by policy")]
    ActionNotPermitted,
    #[msg("Intent has not been approved")]
    IntentNotApproved,
    #[msg("Intent already finalised")]
    IntentAlreadyFinalised,
}

// ── Accounts ──────────────────────────────────────────────────────────────────

/// Persistent identity record for a registered agent.
#[account]
pub struct AgentAccount {
    pub authority: Pubkey,
    pub name: String,          // max 32 chars
    pub policy: RiskPolicy,
    pub intent_count: u64,
    pub bump: u8,
}

/// Inline policy stored with the agent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RiskPolicy {
    /// Maximum lamports the agent may move in a single intent.
    pub max_value_lamports: u64,
    /// Bitmask: bit 0 = Transfer, 1 = Swap, 2 = Stake, 3 = ContractCall.
    pub allowed_actions_mask: u8,
}

impl RiskPolicy {
    pub fn allows_action(&self, action: &ActionType) -> bool {
        let bit = match action {
            ActionType::Transfer    => 0,
            ActionType::Swap        => 1,
            ActionType::Stake       => 2,
            ActionType::ContractCall => 3,
        };
        self.allowed_actions_mask & (1 << bit) != 0
    }
}

/// A single proposed action, evaluated against the agent's policy.
#[account]
pub struct IntentRequest {
    pub agent: Pubkey,
    pub action_type: ActionType,
    pub value_lamports: u64,
    pub status: IntentStatus,
    pub rejection_reason: Option<String>, // set on Rejected
    pub submitted_at: i64,
    pub finalised_at: Option<i64>,
    pub seq: u64, // monotonic per agent
    pub bump: u8,
}

/// Immutable onchain proof that an intent was executed.
#[account]
pub struct ExecutionReceipt {
    pub agent: Pubkey,
    pub intent_seq: u64,
    pub action_type: ActionType,
    pub value_lamports: u64,
    pub executed_at: i64,
    pub bump: u8,
}

// ── Space helpers ─────────────────────────────────────────────────────────────

impl AgentAccount {
    // discriminator(8) + pubkey(32) + string(4+32) + policy(8+1) + u64(8) + u8(1)
    pub const SPACE: usize = 8 + 32 + (4 + 32) + (8 + 1) + 8 + 1;
}

impl IntentRequest {
    // discriminator(8) + pubkey(32) + enum(1) + u64(8) + enum(1)
    // + option<string>(1+4+64) + i64(8) + option<i64>(1+8) + u64(8) + u8(1)
    pub const SPACE: usize = 8 + 32 + 1 + 8 + 1 + (1 + 4 + 64) + 8 + (1 + 8) + 8 + 1;
}

impl ExecutionReceipt {
    // discriminator(8) + pubkey(32) + u64(8) + enum(1) + u64(8) + i64(8) + u8(1)
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8 + 8 + 1;
}

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod basira {
    use super::*;

    /// Register a new agent with a name and an initial risk policy.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        max_value_lamports: u64,
        allowed_actions_mask: u8,
    ) -> Result<()> {
        require!(name.len() <= 32, BasiraError::ActionNotPermitted);

        let agent = &mut ctx.accounts.agent_account;
        agent.authority = ctx.accounts.authority.key();
        agent.name = name;
        agent.policy = RiskPolicy { max_value_lamports, allowed_actions_mask };
        agent.intent_count = 0;
        agent.bump = ctx.bumps.agent_account;

        emit!(AgentRegistered {
            agent: agent.key(),
            authority: agent.authority,
            max_value_lamports,
            allowed_actions_mask,
        });

        Ok(())
    }

    /// Submit an intent. The policy engine evaluates it inline.
    /// Status is set to Approved or Rejected before returning.
    pub fn submit_intent(
        ctx: Context<SubmitIntent>,
        action_type: ActionType,
        value_lamports: u64,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent_account;
        let intent = &mut ctx.accounts.intent_request;
        let clock = Clock::get()?;

        let seq = agent.intent_count;
        agent.intent_count += 1;

        intent.agent = agent.key();
        intent.action_type = action_type.clone();
        intent.value_lamports = value_lamports;
        intent.submitted_at = clock.unix_timestamp;
        intent.finalised_at = None;
        intent.seq = seq;
        intent.bump = ctx.bumps.intent_request;

        // ── Policy evaluation ─────────────────────────────────────────────────
        if !agent.policy.allows_action(&action_type) {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some("action type not permitted".to_string());
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        if value_lamports > agent.policy.max_value_lamports {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some("value exceeds policy limit".to_string());
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        intent.status = IntentStatus::Approved;
        intent.rejection_reason = None;
        emit!(IntentEvaluated { agent: agent.key(), seq, approved: true });

        Ok(())
    }

    /// Execute an approved intent and write an immutable ExecutionReceipt.
    pub fn execute_intent(ctx: Context<ExecuteIntent>) -> Result<()> {
        let intent = &mut ctx.accounts.intent_request;
        require!(intent.status == IntentStatus::Approved, BasiraError::IntentNotApproved);

        let clock = Clock::get()?;
        intent.status = IntentStatus::Executed;
        intent.finalised_at = Some(clock.unix_timestamp);

        let receipt = &mut ctx.accounts.execution_receipt;
        receipt.agent = intent.agent;
        receipt.intent_seq = intent.seq;
        receipt.action_type = intent.action_type.clone();
        receipt.value_lamports = intent.value_lamports;
        receipt.executed_at = clock.unix_timestamp;
        receipt.bump = ctx.bumps.execution_receipt;

        emit!(ReceiptWritten {
            agent: receipt.agent,
            intent_seq: receipt.intent_seq,
            value_lamports: receipt.value_lamports,
            executed_at: receipt.executed_at,
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
        seeds = [b"agent", authority.key().as_ref()],
        bump = agent_account.bump,
        has_one = authority,
        constraint = agent_account.key() == intent_request.agent,
    )]
    pub agent_account: Account<'info, AgentAccount>,

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

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct AgentRegistered {
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub max_value_lamports: u64,
    pub allowed_actions_mask: u8,
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
    pub executed_at: i64,
}
