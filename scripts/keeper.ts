/**
 * The keeper.
 *
 *   npx tsx scripts/keeper.ts
 *
 * Watches every game on the platform and settles each one the moment its clock
 * hits zero, so nobody has to press anything.
 *
 * It cannot redirect a lamport. `settle` always pays that game's last buyer,
 * and it is permissionless — if this process dies, any player can settle from
 * the site and the winner is still paid. This exists purely so nobody has to.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, workspace, setProvider } = pkg;
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

const POLL_MS = Number(process.env.POLL_MS ?? 3000);

async function main() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Arena;
  const conn = provider.connection;
  const me = provider.wallet.publicKey;

  console.log("keeper up");
  console.log("  rpc    ", conn.rpcEndpoint);
  console.log("  program", program.programId.toBase58());
  console.log("  watching every game on the platform\n");

  const busy = new Set<string>();

  async function tick() {
    let games;
    try {
      games = await program.account.game.all();
    } catch (e: any) {
      console.error("could not list games:", String(e?.message ?? e).slice(0, 110));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    for (const g of games) {
      const mint = g.account.mint as PublicKey;
      const key = mint.toBase58();
      if (busy.has(key)) continue;
      if (g.account.deadline.toNumber() > now) continue;

      busy.add(key);
      try {
        const vault = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), mint.toBuffer()], program.programId)[0];
        const holder = g.account.lastBuyer as PublicKey;
        const empty = holder.equals(PublicKey.default);
        const pot = await conn.getBalance(vault);

        const sig = await program.methods.settle().accounts({
          game: g.publicKey,
          vault,
          // an unplayed round pays nobody, so any writable account will do
          winner: empty ? me : holder,
          cranker: me,
          systemProgram: SystemProgram.programId,
        }).rpc();

        const t = new Date().toISOString().slice(11, 19);
        if (empty) {
          console.log(`${t}  ${key.slice(0, 8)}… round ${g.account.round} ended empty — pot rolls over`);
        } else {
          console.log(`${t}  ${key.slice(0, 8)}… paid ${(pot / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${holder.toBase58()}`);
          console.log(`          ${sig}`);
        }
      } catch (e: any) {
        const m = String(e?.message ?? e);
        // StillRunning just means we were a touch early
        if (!m.includes("StillRunning")) {
          console.error(`settle failed for ${key.slice(0, 8)}…:`, m.slice(0, 110));
        }
      } finally {
        busy.delete(key);
      }
    }
  }

  await tick();
  setInterval(tick, POLL_MS);

  process.on("SIGINT", () => {
    console.log("\nkeeper stopping. players can still settle rounds themselves.");
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
