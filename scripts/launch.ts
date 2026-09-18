/**
 * Launch the token and found the Throne.
 *
 *   npx tsx scripts/launch.ts
 *
 * In order:
 *   1. creates the SPL mint
 *   2. mints the whole supply to you, once
 *   3. revokes the mint authority, so no more can ever exist
 *   4. founds the Throne against that mint
 *
 * Step 3 is the one traders check first. A mint with a live mint authority can
 * be inflated at will, and people will not touch it.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, BN, Wallet, workspace, setProvider } = pkg;
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, Connection } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  setAuthority, AuthorityType, getMint,
} from "@solana/spl-token";
import fs from "fs";

// ─────────── settings ───────────
const DECIMALS = 6;
const SUPPLY = 1_000_000_000;          // 1 billion tokens
const ROUND_SECONDS = 600;             // 10 minute rounds
const ADD_SECONDS = 30;                // each take pushes the clock back 30s
const LOCK_SECONDS = 20;               // immunity after taking the seat
const FLOOR_TOKENS = 10_000;            // absolute backstop, dust protection only
const FLOOR_BPS = 25;                  // a take costs 0.25% of REMAINING supply — falls as tokens burn
const STEP_BPS = 11_500;               // each take costs 1.15x the last
const CUT_BPS = 1_000;                 // 10% of fees to the treasury
// ────────────────────────────────

const unit = (n: number) => BigInt(n) * BigInt(10 ** DECIMALS);

async function main() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Throne;
  const conn = provider.connection;
  const me = (provider.wallet as any).payer as Keypair;

  const treasury = process.env.TREASURY ? new PublicKey(process.env.TREASURY) : me.publicKey;

  console.log("\ncluster  :", conn.rpcEndpoint);
  console.log("deployer :", me.publicKey.toBase58());
  console.log("treasury :", treasury.toBase58());

  const bal = await conn.getBalance(me.publicKey);
  if (bal < 0.3 * LAMPORTS_PER_SOL) throw new Error("Not enough SOL. Top up and try again.");

  console.log("\ncreating the mint…");
  const mint = await createMint(conn, me, me.publicKey, null, DECIMALS);
  console.log("  mint:", mint.toBase58());

  const ata = await getOrCreateAssociatedTokenAccount(conn, me, mint, me.publicKey);
  await mintTo(conn, me, mint, ata.address, me, unit(SUPPLY));
  console.log(`  minted ${SUPPLY.toLocaleString()} tokens to you`);

  await setAuthority(conn, me, mint, me, AuthorityType.MintTokens, null);
  const info = await getMint(conn, mint);
  if (info.mintAuthority !== null) throw new Error("mint authority is still live — stop and fix this");
  console.log("  mint authority revoked. the supply can never grow.");

  const thronePda = PublicKey.findProgramAddressSync([Buffer.from("throne")], program.programId)[0];
  const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId)[0];

  console.log(`\nfounding the Throne — ${ROUND_SECONDS / 60} minute rounds, +${ADD_SECONDS}s per take, ${LOCK_SECONDS}s immunity…`);
  const sig = await program.methods
    .initialize(
      new BN(ROUND_SECONDS), new BN(ADD_SECONDS), new BN(LOCK_SECONDS),
      new BN(unit(FLOOR_TOKENS).toString()), FLOOR_BPS, STEP_BPS, CUT_BPS
    )
    .accounts({
      throne: thronePda, vault: vaultPda, mint, treasury,
      authority: me.publicKey, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  tx:", sig);

  const out = {
    cluster: conn.rpcEndpoint,
    programId: program.programId.toBase58(),
    mint: mint.toBase58(),
    throne: thronePda.toBase58(),
    pot: vaultPda.toBase58(),
    treasury: treasury.toBase58(),
    launchedAt: new Date().toISOString(),
  };
  fs.writeFileSync("./launch.json", JSON.stringify(out, null, 2));

  console.log("\n─────────────────────────────────────────────");
  console.log("mint (the CA) ", out.mint);
  console.log("throne        ", out.throne);
  console.log("pot           ", out.pot);
  console.log("program       ", out.programId);
  console.log("─────────────────────────────────────────────");
  console.log("\nSaved to launch.json. Publish the pot address — anyone can check");
  console.log("its balance, and nobody has a key for it.\n");
  console.log("Next:");
  console.log("  • add liquidity, then lock or burn the LP tokens");
  console.log("  • point your creator-fee wallet at scripts/keeper.ts");
  console.log("  • copy the mint into app/config.json as buyUrl");
  console.log("  • when you are happy, hand the authority to the system program\n");
}

main().catch(e => { console.error(e); process.exit(1); });
