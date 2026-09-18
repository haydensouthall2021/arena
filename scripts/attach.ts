/**
 * Attach a game to a token.
 *
 *   MINT=<mint> TREASURY=<your wallet> npx tsx scripts/attach.ts
 *   ...then re-run with CONFIRM=1 once the checks look right.
 *
 * This is the same permissionless path anyone uses. Nothing here is special to
 * the platform operator — any wallet can run it for any mint.
 *
 * Everything you set is frozen at registration and cannot be changed after.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, workspace, setProvider } = pkg;
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

// ─────────── this game's settings, permanent ───────────
const START_SECONDS = 600;   // round with nobody playing: 10 minutes
const SHRINK_SECONDS = 2;    // each buy knocks this off the clock
const MIN_SECONDS = 30;      // the clock never goes below this
const FLOOR_BPS = 25;        // a buy costs 0.25% of REMAINING supply
const STEP_BPS = 11_200;     // each buy costs 12% more, resets each round
const CREATOR_BPS = 1_000;   // 10% of fees to the coin's own treasury
// ───────────────────────────────────────────────────────

async function main() {
  const mintStr = process.env.MINT;
  if (!mintStr) throw new Error("Set MINT to the coin's address.");
  const mint = new PublicKey(mintStr);

  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Arena;
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const creatorTreasury = process.env.TREASURY ? new PublicKey(process.env.TREASURY) : me;

  const platformPda = PublicKey.findProgramAddressSync([Buffer.from("platform")], program.programId)[0];
  const gamePda = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), mint.toBuffer()], program.programId)[0];
  const vaultPda = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()], program.programId)[0];

  const plat = await program.account.platform.fetch(platformPda);

  console.log("\ncluster  :", conn.rpcEndpoint);
  console.log("you      :", me.toBase58());
  console.log("your cut goes to:", creatorTreasury.toBase58());
  console.log("mint     :", mint.toBase58());

  const acct = await conn.getAccountInfo(mint);
  if (!acct) throw new Error("No mint at that address.");
  const TOKEN_PROG = acct.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const info = await getMint(conn, mint, undefined, TOKEN_PROG);

  console.log("\nthe coin:");
  console.log("  token program  ", TOKEN_PROG.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "classic SPL");
  console.log("  supply         ", (Number(info.supply) / 10 ** info.decimals).toLocaleString());
  console.log("  mint authority ", info.mintAuthority ? "STILL LIVE — supply can be inflated" : "revoked ✓");
  console.log("  freeze authority", info.freezeAuthority ? "STILL LIVE" : "revoked ✓");

  const cost = Number(info.supply) * FLOOR_BPS / 10_000 / 10 ** info.decimals;
  console.log("\nthe game:");
  console.log(`  a buy costs    ${cost.toLocaleString()} tokens (${(FLOOR_BPS/100).toFixed(2)}% of supply)`);
  console.log(`  round          ${START_SECONDS / 60} min, −${SHRINK_SECONDS}s per buy, floor ${MIN_SECONDS}s`);
  console.log(`  price step     +${(STEP_BPS - 10_000) / 100}% per buy`);
  console.log(`  your cut       ${(CREATOR_BPS / 100).toFixed(1)}% of fees deposited`);
  console.log(`  platform cut   ${(plat.platformBps / 100).toFixed(1)}%`);
  console.log(`  to the pot     ${((10_000 - CREATOR_BPS - plat.platformBps) / 100).toFixed(1)}%`);
  console.log(`\n  registration   ${(plat.registerFee.toNumber() / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  if (await conn.getAccountInfo(gamePda)) {
    console.log("\nThis token already has a game attached.\n");
    return;
  }
  if (!process.env.CONFIRM) {
    console.log("\nNothing written. Re-run with CONFIRM=1.");
    console.log("Everything above is permanent once set.\n");
    return;
  }

  const sig = await program.methods
    .register(
      new BN(START_SECONDS), new BN(SHRINK_SECONDS), new BN(MIN_SECONDS),
      FLOOR_BPS, STEP_BPS, CREATOR_BPS
    )
    .accounts({
      platform: platformPda, game: gamePda, vault: vaultPda, mint,
      platformTreasury: plat.treasury, creatorTreasury,
      creator: me, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const out = {
    cluster: conn.rpcEndpoint, programId: program.programId.toBase58(),
    mint: mint.toBase58(), game: gamePda.toBase58(), pot: vaultPda.toBase58(),
    creatorTreasury: creatorTreasury.toBase58(), attachedAt: new Date().toISOString(),
  };
  const file = `./game-${mint.toBase58().slice(0, 8)}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log("\n  tx:", sig);
  console.log("\n─────────────────────────────────────────────");
  console.log("mint (the CA) ", out.mint);
  console.log("pot           ", out.pot);
  console.log("game          ", out.game);
  console.log("─────────────────────────────────────────────");
  console.log("\nThe pot address is public. Anyone can check its balance and");
  console.log("nobody holds a key for it. Saved to", file, "\n");
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
