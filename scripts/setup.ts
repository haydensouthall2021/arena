/**
 * One-time platform setup.
 *
 *   npx tsx scripts/setup.ts            → shows what it will do, writes nothing
 *   CONFIRM=1 npx tsx scripts/setup.ts  → does it
 *
 * Both numbers below are permanent. The program hard-caps them (5 SOL and 10%)
 * so they can never be raised beyond that later, but within the cap what you
 * set here is what you get forever.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, workspace, setProvider } = pkg;
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "fs";

// ─────────── settings ───────────
const REGISTER_FEE = 0.5 * LAMPORTS_PER_SOL;  // charged once when a token attaches
const PLATFORM_BPS = 500;                      // 5% of fees deposited into any pot
// ────────────────────────────────

async function main() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Arena;
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const treasury = process.env.TREASURY ? new PublicKey(process.env.TREASURY) : me;

  const platform = PublicKey.findProgramAddressSync([Buffer.from("platform")], program.programId)[0];

  console.log("\ncluster  :", conn.rpcEndpoint);
  console.log("program  :", program.programId.toBase58());
  console.log("authority:", me.toBase58());
  console.log("treasury :", treasury.toBase58());
  console.log("\nsettings, permanent once set:");
  console.log("  registration fee", (REGISTER_FEE / LAMPORTS_PER_SOL).toFixed(3), "SOL per token");
  console.log("  platform share  ", (PLATFORM_BPS / 100).toFixed(1) + "% of fees deposited into any pot");
  console.log("\n  hard caps in the program: 5 SOL and 10%. These cannot be exceeded, ever.");

  const existing = await conn.getAccountInfo(platform);
  if (existing) {
    const p = await program.account.platform.fetch(platform);
    console.log("\nAlready set up.");
    console.log("  games attached:", p.games.toString());
    console.log("  fee:", (p.registerFee.toNumber() / LAMPORTS_PER_SOL).toFixed(3), "SOL");
    console.log("  share:", (p.platformBps / 100).toFixed(1) + "%");
    return;
  }

  if (!process.env.CONFIRM) {
    console.log("\nNothing written. Re-run with CONFIRM=1.\n");
    return;
  }

  const sig = await program.methods
    .initializePlatform(new BN(REGISTER_FEE), PLATFORM_BPS)
    .accounts({ platform, treasury, authority: me, systemProgram: SystemProgram.programId })
    .rpc();

  fs.writeFileSync("./platform.json", JSON.stringify({
    cluster: conn.rpcEndpoint,
    programId: program.programId.toBase58(),
    platform: platform.toBase58(),
    treasury: treasury.toBase58(),
    registerFee: REGISTER_FEE,
    platformBps: PLATFORM_BPS,
    setUpAt: new Date().toISOString(),
  }, null, 2));

  console.log("\n  tx:", sig);
  console.log("\n─────────────────────────────────────────────");
  console.log("platform ", platform.toBase58());
  console.log("program  ", program.programId.toBase58());
  console.log("─────────────────────────────────────────────");
  console.log("\nAny token can now attach a game with scripts/attach.ts\n");
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
