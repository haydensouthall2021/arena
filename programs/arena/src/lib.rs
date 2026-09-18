use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self as token, Burn, Mint, TokenAccount, TokenInterface};

declare_id!("oDDawv2GGcWhMCVjsxfBppYZUTp8XF1nGcqNUSFuFWL");

/// Arena.
///
/// **Any token can attach a game to itself.** One transaction, no approval,
/// no gatekeeping. The coin's creator points their mint at this program and
/// their holders get Last Man: a clock, a pot fed by trading fees, and a slot
/// people burn tokens to take.
///
/// Every game is its own instance, keyed by mint. Its own pot, its own clock,
/// its own burn. Nothing is shared between them except the code.
///
/// Why it is built this way:
///
/// * **Permissionless registration.** If registering needed approval, it stops
///   being infrastructure and becomes a service with a gatekeeper — and the
///   whole point is that a coin can plug in at 3am without asking anyone.
/// * **Two treasuries per game.** The platform takes a fixed share, the coin's
///   creator takes theirs, both set at registration and immovable afterwards.
///   Neither can be changed later to squeeze the other.
/// * **The platform authority can never touch a game's pot.** It can pause new
///   registrations. That is all. Read `settle` and check.
/// * Rules carried from The Throne and Last Man: pot at a PDA with no private
///   key, permissionless settle that pays only the last buyer, pause that can
///   never stop a payout, no oracle, `token_interface` so Token-2022 works.
#[program]
pub mod arena {
    use super::*;

    /// Run once by whoever deploys. Sets the platform fee and where it goes.
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        register_fee: u64,
        platform_bps: u16,
    ) -> Result<()> {
        // hard ceilings, so the platform can never be turned into a rake
        require!(register_fee <= 5_000_000_000, E::FeeTooHigh);   // max 5 SOL
        require!(platform_bps <= 1_000, E::FeeTooHigh);           // max 10%

        let p = &mut ctx.accounts.platform;
        p.authority = ctx.accounts.authority.key();
        p.treasury = ctx.accounts.treasury.key();
        p.register_fee = register_fee;
        p.platform_bps = platform_bps;
        p.games = 0;
        p.paused = false;
        p.bump = ctx.bumps.platform;

        emit!(PlatformReady { register_fee, platform_bps });
        Ok(())
    }

    /// Attach a game to a token. Anyone may call this for any mint.
    ///
    /// The caller becomes that game's creator and names their own treasury.
    /// Everything about the game is fixed here and cannot be changed later —
    /// deliberately, so nobody can tilt a live game.
    pub fn register(
        ctx: Context<Register>,
        start_seconds: i64,
        shrink_seconds: i64,
        min_seconds: i64,
        floor_bps: u16,
        step_bps: u16,
        creator_bps: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.platform.paused, E::Paused);
        require!((60..=86_400).contains(&start_seconds), E::BadTimer);
        require!((0..=60).contains(&shrink_seconds), E::BadTimer);
        require!(min_seconds >= 30 && min_seconds <= start_seconds, E::BadTimer);
        require!((1..=500).contains(&floor_bps), E::BadFloor);
        require!((10_000..=30_000).contains(&step_bps), E::BadStep);
        // creator cut capped so a game cannot be set up to eat its own pot
        require!(creator_bps <= 2_000, E::FeeTooHigh);

        let fee = ctx.accounts.platform.register_fee;
        if fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.platform_treasury.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;
        let g = &mut ctx.accounts.game;
        g.mint = ctx.accounts.mint.key();
        g.creator = ctx.accounts.creator.key();
        g.creator_treasury = ctx.accounts.creator_treasury.key();
        g.last_buyer = Pubkey::default();
        g.round = 1;
        g.start_seconds = start_seconds;
        g.shrink_seconds = shrink_seconds;
        g.min_seconds = min_seconds;
        g.timer_seconds = start_seconds;
        g.deadline = now + start_seconds;
        g.floor_bps = floor_bps;
        g.step_bps = step_bps;
        g.creator_bps = creator_bps;
        g.platform_bps = ctx.accounts.platform.platform_bps;
        g.cost_tokens = 0;
        g.buys_this_round = 0;
        g.total_burned = 0;
        g.total_paid_out = 0;
        g.rounds_settled = 0;
        g.bump = ctx.bumps.game;
        g.vault_bump = ctx.bumps.vault;

        let p = &mut ctx.accounts.platform;
        p.games = p.games.saturating_add(1);

        emit!(GameRegistered {
            mint: g.mint, creator: g.creator, deadline: g.deadline,
            start_seconds, fee_paid: fee,
        });
        Ok(())
    }

    /// Put SOL into a game's pot. Permissionless — anyone can feed any game.
    pub fn deposit_fees(ctx: Context<DepositFees>, amount: u64) -> Result<()> {
        require!(amount > 0, E::Zero);

        let (plat_bps, creat_bps) = {
            let g = &ctx.accounts.game;
            (g.platform_bps as u128, g.creator_bps as u128)
        };
        let plat = (amount as u128 * plat_bps / 10_000) as u64;
        let creat = (amount as u128 * creat_bps / 10_000) as u64;
        let to_pot = amount.checked_sub(plat).ok_or(E::Overflow)?
                           .checked_sub(creat).ok_or(E::Overflow)?;

        let sys = ctx.accounts.system_program.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();

        if plat > 0 {
            system_program::transfer(
                CpiContext::new(sys.clone(), system_program::Transfer {
                    from: payer.clone(), to: ctx.accounts.platform_treasury.to_account_info(),
                }), plat)?;
        }
        if creat > 0 {
            system_program::transfer(
                CpiContext::new(sys.clone(), system_program::Transfer {
                    from: payer.clone(), to: ctx.accounts.creator_treasury.to_account_info(),
                }), creat)?;
        }
        system_program::transfer(
            CpiContext::new(sys, system_program::Transfer {
                from: payer, to: ctx.accounts.vault.to_account_info(),
            }), to_pot)?;

        emit!(FeesIn {
            mint: ctx.accounts.game.mint, to_pot, platform: plat, creator: creat,
            pot: ctx.accounts.vault.lamports(),
        });
        Ok(())
    }

    /// Take the last slot in a game. Burns that game's token.
    pub fn buy(ctx: Context<Buy>, max_cost: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        let cost = {
            let g = &ctx.accounts.game;
            require!(now < g.deadline, E::RoundOver);
            require_keys_neq!(ctx.accounts.buyer.key(), g.last_buyer, E::AlreadyYours);
            let supply = ctx.accounts.mint.supply as u128;
            let dynamic = (supply * g.floor_bps as u128 / 10_000) as u64;
            g.cost_tokens.max(dynamic)
        };
        require!(cost > 0, E::Zero);
        require!(cost <= max_cost, E::PriceMoved);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.buyer_tokens.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            cost,
        )?;

        let previous = ctx.accounts.game.last_buyer;
        let g = &mut ctx.accounts.game;
        g.last_buyer = ctx.accounts.buyer.key();
        g.timer_seconds = (g.timer_seconds - g.shrink_seconds).max(g.min_seconds);
        g.deadline = now + g.timer_seconds;
        g.cost_tokens = ((cost as u128 * g.step_bps as u128 / 10_000) as u64).max(cost + 1);
        g.buys_this_round = g.buys_this_round.saturating_add(1);
        g.total_burned = g.total_burned.saturating_add(cost);

        emit!(Bought {
            mint: g.mint, buyer: g.last_buyer, previous, burned: cost,
            next_cost: g.cost_tokens, deadline: g.deadline, timer: g.timer_seconds,
            pot: ctx.accounts.vault.lamports(),
        });
        Ok(())
    }

    /// Pay a game's last buyer and start its next round. Anyone may call it.
    ///
    /// Note what is NOT in this instruction's accounts: the platform. The
    /// platform authority has no say over any game's payout and cannot block
    /// one. Nothing here reads a pause flag.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.game.deadline, E::StillRunning);

        let winner_key = ctx.accounts.game.last_buyer;
        let mut payout = 0u64;

        if winner_key != Pubkey::default() {
            require_keys_eq!(ctx.accounts.winner.key(), winner_key, E::WrongWinner);
            let rent = Rent::get()?.minimum_balance(0);
            payout = ctx.accounts.vault.lamports().saturating_sub(rent);
            if payout > 0 {
                let mint_key = ctx.accounts.game.mint;
                let bump = ctx.accounts.game.vault_bump;
                let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[bump]];
                system_program::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.winner.to_account_info(),
                        },
                        &[seeds],
                    ),
                    payout,
                )?;
            }
        }

        let g = &mut ctx.accounts.game;
        g.total_paid_out = g.total_paid_out.saturating_add(payout);
        g.rounds_settled = g.rounds_settled.saturating_add(1);
        g.round = g.round.saturating_add(1);
        g.last_buyer = Pubkey::default();
        g.buys_this_round = 0;
        g.cost_tokens = 0;
        g.timer_seconds = g.start_seconds;
        g.deadline = now + g.start_seconds;

        emit!(Settled { mint: g.mint, round: g.round - 1, winner: winner_key, payout });
        Ok(())
    }

    /// Stops NEW registrations only. Existing games carry on untouched —
    /// their buys, their settles, their pots. This is the only lever the
    /// platform authority has.
    pub fn set_platform_paused(ctx: Context<PlatformAuthority>, paused: bool) -> Result<()> {
        ctx.accounts.platform.paused = paused;
        Ok(())
    }

    pub fn set_platform_authority(ctx: Context<PlatformAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.platform.authority = new_authority;
        Ok(())
    }
}

#[account]
pub struct Platform {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub register_fee: u64,
    pub platform_bps: u16,
    pub games: u64,
    pub paused: bool,
    pub bump: u8,
}
impl Platform { pub const LEN: usize = 8 + 32 * 2 + 8 + 2 + 8 + 1 + 1; }

#[account]
pub struct Game {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub creator_treasury: Pubkey,
    pub last_buyer: Pubkey,
    pub round: u64,
    pub start_seconds: i64,
    pub shrink_seconds: i64,
    pub min_seconds: i64,
    pub timer_seconds: i64,
    pub deadline: i64,
    pub cost_tokens: u64,
    pub floor_bps: u16,
    pub step_bps: u16,
    pub creator_bps: u16,
    pub platform_bps: u16,
    pub buys_this_round: u32,
    pub total_burned: u64,
    pub total_paid_out: u64,
    pub rounds_settled: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Game {
    pub const LEN: usize = 8 + 32 * 4 + 8 + 8 * 5 + 8 + 2 * 4 + 4 + 8 * 3 + 1 + 1;
}

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(init, payer = authority, space = Platform::LEN, seeds = [b"platform"], bump)]
    pub platform: Account<'info, Platform>,
    /// CHECK: only ever receives lamports
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump,
              constraint = platform.treasury == platform_treasury.key() @ E::WrongTreasury)]
    pub platform: Account<'info, Platform>,
    #[account(
        init,
        payer = creator,
        space = Game::LEN,
        seeds = [b"game", mint.key().as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,
    /// CHECK: lamport-only PDA; this game's pot. No private key exists.
    #[account(seeds = [b"vault", mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: checked against platform.treasury
    #[account(mut)]
    pub platform_treasury: UncheckedAccount<'info>,
    /// CHECK: where this game's creator cut goes; only receives lamports
    pub creator_treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFees<'info> {
    #[account(seeds = [b"game", game.mint.as_ref()], bump = game.bump,
              constraint = game.creator_treasury == creator_treasury.key() @ E::WrongTreasury)]
    pub game: Account<'info, Game>,
    /// CHECK: seeds-checked
    #[account(mut, seeds = [b"vault", game.mint.as_ref()], bump = game.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump,
              constraint = platform.treasury == platform_treasury.key() @ E::WrongTreasury)]
    pub platform: Account<'info, Platform>,
    /// CHECK: checked against platform.treasury
    #[account(mut)]
    pub platform_treasury: UncheckedAccount<'info>,
    /// CHECK: checked against game.creator_treasury
    #[account(mut)]
    pub creator_treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut, seeds = [b"game", mint.key().as_ref()], bump = game.bump, has_one = mint)]
    pub game: Account<'info, Game>,
    /// CHECK: seeds-checked
    #[account(seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut,
        constraint = buyer_tokens.mint == mint.key() @ E::WrongMint,
        constraint = buyer_tokens.owner == buyer.key() @ E::NotYours)]
    pub buyer_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [b"game", game.mint.as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    /// CHECK: seeds-checked
    #[account(mut, seeds = [b"vault", game.mint.as_ref()], bump = game.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must equal game.last_buyer when there is one
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlatformAuthority<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump, has_one = authority)]
    pub platform: Account<'info, Platform>,
    pub authority: Signer<'info>,
}

#[event]
pub struct PlatformReady { pub register_fee: u64, pub platform_bps: u16 }
#[event]
pub struct GameRegistered {
    pub mint: Pubkey, pub creator: Pubkey, pub deadline: i64,
    pub start_seconds: i64, pub fee_paid: u64,
}
#[event]
pub struct FeesIn { pub mint: Pubkey, pub to_pot: u64, pub platform: u64, pub creator: u64, pub pot: u64 }
#[event]
pub struct Bought {
    pub mint: Pubkey, pub buyer: Pubkey, pub previous: Pubkey, pub burned: u64,
    pub next_cost: u64, pub deadline: i64, pub timer: i64, pub pot: u64,
}
#[event]
pub struct Settled { pub mint: Pubkey, pub round: u64, pub winner: Pubkey, pub payout: u64 }

#[error_code]
pub enum E {
    #[msg("Fee is above the hard ceiling")] FeeTooHigh,
    #[msg("Timer settings are out of range")] BadTimer,
    #[msg("Floor must be 1 to 500 bps of supply")] BadFloor,
    #[msg("Step must be between 1.0x and 3.0x")] BadStep,
    #[msg("Amount must be above zero")] Zero,
    #[msg("New registrations are paused")] Paused,
    #[msg("This round is over. Settle it first")] RoundOver,
    #[msg("You already hold the last slot")] AlreadyYours,
    #[msg("Price rose above your limit before your transaction landed")] PriceMoved,
    #[msg("The round is still running")] StillRunning,
    #[msg("That account is not the winner")] WrongWinner,
    #[msg("Wrong treasury account")] WrongTreasury,
    #[msg("Wrong mint for that token account")] WrongMint,
    #[msg("That token account is not yours")] NotYours,
    #[msg("Arithmetic overflow")] Overflow,
}
