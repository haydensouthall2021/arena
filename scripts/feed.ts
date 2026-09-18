/**
 * Put SOL into the pot.
 *
 *   npx tsx scripts/feed.ts 5        → pushes 5 SOL in
 *
 * Stands in for the keeper while testing. In production this is creator fees
 * being swept in automatically, but the instruction is the same one and it is
 * permissionless — anyone at all can top the pot up.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, workspace, setProvider } = pkg;
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import fs from "fs";

async function main() {
  const amount = Number(process.argv[2] ?? 2);
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Throne;
  const conn = provider.connection;

  const launch = JSON.parse(fs.readFileSync("./launch.json", "utf8"));
  const thronePda = new PublicKey(launch.throne);
  const vaultPda = new PublicKey(launch.pot);
  const treasury = new PublicKey(launch.treasury);

  const before = await conn.getBalance(vaultPda);
  await program.methods
    .depositFees(new BN(amount * LAMPORTS_PER_SOL))
    .accounts({
      throne: thronePda, vault: vaultPda, treasury,
      payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const after = await conn.getBalance(vaultPda);
  console.log(`pot: ${(before / LAMPORTS_PER_SOL).toFixed(3)} → ${(after / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  console.log(`(10% of the ${amount} went to the treasury as the creator cut)`);
}

main().catch(e => { console.error(e); process.exit(1); });
