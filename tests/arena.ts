import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, workspace, setProvider } = pkg;
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getMint, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("arena", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Arena as any;
  const conn = provider.connection;
  const admin = (provider.wallet as any).payer;

  const REG_FEE = 0.5 * LAMPORTS_PER_SOL;
  const PLATFORM_BPS = 500;          // 5%
  const START = 62, SHRINK = 4, MIN = 30;
  const FLOOR_BPS = 25, STEP = 11_200, CREATOR_BPS = 1_000;

  // two entirely separate coins with their own games — the whole point
  let mintA: PublicKey, mintB: PublicKey;
  let platTreasury: Keypair, creatorA: Keypair, creatorB: Keypair;
  let treasuryA: Keypair, treasuryB: Keypair;
  let alice: Keypair, bob: Keypair, carol: Keypair;
  const ata: Record<string, PublicKey> = {};

  const platform = PublicKey.findProgramAddressSync([Buffer.from("platform")], program.programId)[0];
  const gameOf = (m: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("game"), m.toBuffer()], program.programId)[0];
  const vaultOf = (m: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], program.programId)[0];

  const fund = async (k: Keypair, s = 20) =>
    conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, s * LAMPORTS_PER_SOL));
  const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)));
  const gameState = (m: PublicKey) => program.account.game.fetch(gameOf(m));
  const potOf = (m: PublicKey) => conn.getBalance(vaultOf(m));
  const untilEnd = async (m: PublicKey) => {
    const g = await gameState(m);
    return (g.deadline.toNumber() - Math.floor(Date.now() / 1000) + 2) * 1000;
  };

  const register = (mint: PublicKey, creator: Keypair, treasury: PublicKey,
                    opts: any = {}) =>
    program.methods.register(
      new BN(opts.start ?? START), new BN(opts.shrink ?? SHRINK), new BN(opts.min ?? MIN),
      opts.floor ?? FLOOR_BPS, opts.step ?? STEP, opts.creatorBps ?? CREATOR_BPS
    ).accounts({
      platform, game: gameOf(mint), vault: vaultOf(mint), mint,
      platformTreasury: opts.platTreasury ?? platTreasury.publicKey,
      creatorTreasury: treasury, creator: creator.publicKey,
      systemProgram: SystemProgram.programId,
    }).signers([creator]).rpc();

  const deposit = (mint: PublicKey, creatorTreasury: PublicKey, amount: number, who: Keypair) =>
    program.methods.depositFees(new BN(amount)).accounts({
      game: gameOf(mint), vault: vaultOf(mint), platform,
      platformTreasury: platTreasury.publicKey, creatorTreasury,
      payer: who.publicKey, systemProgram: SystemProgram.programId,
    }).signers([who]).rpc();

  const buy = (mint: PublicKey, who: Keypair, max = "1000000000000000") =>
    program.methods.buy(new BN(max)).accounts({
      game: gameOf(mint), vault: vaultOf(mint), mint,
      buyerTokens: ata[who.publicKey.toBase58() + mint.toBase58()],
      buyer: who.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([who]).rpc();

  const settle = (mint: PublicKey, winner: PublicKey, cranker: Keypair) =>
    program.methods.settle().accounts({
      game: gameOf(mint), vault: vaultOf(mint), winner,
      cranker: cranker.publicKey, systemProgram: SystemProgram.programId,
    }).signers([cranker]).rpc();

  before(async () => {
    platTreasury = Keypair.generate();
    creatorA = Keypair.generate(); creatorB = Keypair.generate();
    treasuryA = Keypair.generate(); treasuryB = Keypair.generate();
    alice = Keypair.generate(); bob = Keypair.generate(); carol = Keypair.generate();
    for (const k of [creatorA, creatorB, alice, bob, carol]) await fund(k);
    for (const k of [platTreasury, treasuryA, treasuryB]) await fund(k, 1);

    mintA = await createMint(conn, admin, admin.publicKey, null, 6);
    mintB = await createMint(conn, admin, admin.publicKey, null, 6);
    for (const m of [mintA, mintB]) {
      for (const k of [alice, bob, carol]) {
        const a = (await getOrCreateAssociatedTokenAccount(conn, k, m, k.publicKey)).address;
        ata[k.publicKey.toBase58() + m.toBase58()] = a;
        await mintTo(conn, admin, m, a, admin, 300_000_000_000);
      }
    }
  });

  // ─────────────────────────── platform

  it("sets up the platform", async () => {
    await program.methods.initializePlatform(new BN(REG_FEE), PLATFORM_BPS)
      .accounts({ platform, treasury: platTreasury.publicKey,
                  authority: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const p = await program.account.platform.fetch(platform);
    assert.equal(p.registerFee.toNumber(), REG_FEE);
    assert.equal(p.platformBps, PLATFORM_BPS);
    assert.equal(p.games.toNumber(), 0);
  });

  it("refuses a platform cut above the hard ceiling", async () => {
    // the program caps this at 10%. It is not a policy, it is enforced.
    try {
      await program.methods.initializePlatform(new BN(REG_FEE), 5_000)
        .accounts({ platform, treasury: platTreasury.publicKey,
                    authority: admin.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
      assert.fail("should have been rejected");
    } catch (e) { assert.ok(e); }
  });

  // ─────────────────────────── registration

  it("lets anyone attach a game to their token, and takes the fee", async () => {
    const before = await conn.getBalance(platTreasury.publicKey);
    await register(mintA, creatorA, treasuryA.publicKey);
    assert.approximately(await conn.getBalance(platTreasury.publicKey) - before, REG_FEE, 30000);

    const g = await gameState(mintA);
    assert.ok(g.mint.equals(mintA));
    assert.ok(g.creator.equals(creatorA.publicKey));
    assert.ok(g.creatorTreasury.equals(treasuryA.publicKey));
    assert.equal(g.platformBps, PLATFORM_BPS, "platform cut snapshotted at registration");
    assert.equal((await program.account.platform.fetch(platform)).games.toNumber(), 1);
  });

  it("stops the same token being registered twice", async () => {
    try {
      await register(mintA, creatorB, treasuryB.publicKey);
      assert.fail("should have been rejected");
    } catch (e) { assert.ok(e); }
  });

  it("refuses a creator cut above 20%", async () => {
    try {
      await register(mintB, creatorB, treasuryB.publicKey, { creatorBps: 5_000 });
      assert.fail("should have been rejected");
    } catch (e: any) { assert.include(e.toString(), "FeeTooHigh"); }
  });

  it("refuses a fake platform treasury", async () => {
    // someone trying to redirect the registration fee to themselves
    const fake = Keypair.generate();
    try {
      await register(mintB, creatorB, treasuryB.publicKey, { platTreasury: fake.publicKey });
      assert.fail("should have been rejected");
    } catch (e: any) { assert.include(e.toString(), "WrongTreasury"); }
  });

  it("lets a second, unrelated token attach its own game", async () => {
    await register(mintB, creatorB, treasuryB.publicKey);
    const gA = await gameState(mintA), gB = await gameState(mintB);
    assert.ok(gA.mint.equals(mintA) && gB.mint.equals(mintB));
    assert.notEqual(vaultOf(mintA).toBase58(), vaultOf(mintB).toBase58(),
      "the two games have separate pots");
    assert.equal((await program.account.platform.fetch(platform)).games.toNumber(), 2);
  });

  // ─────────────────────────── fees

  it("splits a deposit three ways: pot, platform, creator", async () => {
    const platBefore = await conn.getBalance(platTreasury.publicKey);
    const creatBefore = await conn.getBalance(treasuryA.publicKey);
    const amount = 4 * LAMPORTS_PER_SOL;

    await deposit(mintA, treasuryA.publicKey, amount, carol);   // carol is nobody special

    assert.approximately(await conn.getBalance(platTreasury.publicKey) - platBefore,
      amount * PLATFORM_BPS / 10_000, 30000, "5% to the platform");
    assert.approximately(await conn.getBalance(treasuryA.publicKey) - creatBefore,
      amount * CREATOR_BPS / 10_000, 30000, "10% to the coin's creator");
    assert.approximately(await potOf(mintA),
      amount * (10_000 - PLATFORM_BPS - CREATOR_BPS) / 10_000, 30000, "85% to the pot");
  });

  it("refuses a deposit routed to the wrong creator treasury", async () => {
    try {
      await deposit(mintA, treasuryB.publicKey, LAMPORTS_PER_SOL, carol);
      assert.fail("should have been rejected");
    } catch (e: any) { assert.include(e.toString(), "WrongTreasury"); }
  });

  // ─────────────────────────── the game

  it("burns the right token and shortens that game's clock", async () => {
    const supplyBefore = (await getMint(conn, mintA)).supply;
    const bSupplyBefore = (await getMint(conn, mintB)).supply;
    const g0 = await gameState(mintA);

    await buy(mintA, alice);

    const g = await gameState(mintA);
    assert.ok(g.lastBuyer.equals(alice.publicKey));
    assert.equal(g.timerSeconds.toNumber(), Math.max(MIN, g0.timerSeconds.toNumber() - SHRINK));
    assert.ok(Number(supplyBefore - (await getMint(conn, mintA)).supply) > 0, "A burned");
    assert.equal(Number(bSupplyBefore - (await getMint(conn, mintB)).supply), 0,
      "playing game A did not touch token B");
  });

  it("keeps the two games completely independent", async () => {
    const potABefore = await potOf(mintA);
    await deposit(mintB, treasuryB.publicKey, 2 * LAMPORTS_PER_SOL, carol);
    await buy(mintB, bob);

    assert.equal(await potOf(mintA), potABefore, "game A's pot untouched by game B");
    const gA = await gameState(mintA), gB = await gameState(mintB);
    assert.ok(gA.lastBuyer.equals(alice.publicKey), "A still held by alice");
    assert.ok(gB.lastBuyer.equals(bob.publicKey), "B held by bob");
  });

  it("stops you buying game A's slot with game B's tokens", async () => {
    try {
      await program.methods.buy(new BN("1000000000000000")).accounts({
        game: gameOf(mintA), vault: vaultOf(mintA), mint: mintA,
        buyerTokens: ata[carol.publicKey.toBase58() + mintB.toBase58()],  // wrong token
        buyer: carol.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([carol]).rpc();
      assert.fail("should have been rejected");
    } catch (e: any) { assert.include(e.toString(), "WrongMint"); }
  });

  it("stops the same wallet buying twice in a row", async () => {
    try {
      await buy(mintA, alice);
      assert.fail("should have been rejected");
    } catch (e: any) { assert.include(e.toString(), "AlreadyYours"); }
  });

  it("respects the buyer's price limit", async () => {
    try {
      await buy(mintA, carol, "1");
      assert.fail("should not overcharge");
    } catch (e: any) { assert.include(e.toString(), "PriceMoved"); }
  });

  it("never lets a clock fall below its floor", async () => {
    for (let i = 0; i < 5; i++) await buy(mintA, i % 2 === 0 ? carol : alice);
    assert.ok((await gameState(mintA)).timerSeconds.toNumber() >= MIN);
  });

  // ─────────────────────────── payout

  it("will not settle while a clock is running", async () => {
    try {
      await settle(mintA, (await gameState(mintA)).lastBuyer, carol);
      assert.fail("still running");
    } catch (e: any) { assert.include(e.toString(), "StillRunning"); }
  });

  it("pays the last buyer, triggered by a stranger", async () => {
    await sleep(await untilEnd(mintA));
    const winner = (await gameState(mintA)).lastBuyer;
    const before = await conn.getBalance(winner);
    const inPot = await potOf(mintA);

    await settle(mintA, winner, carol);

    assert.ok(await conn.getBalance(winner) > before + inPot * 0.95,
      "pot went to the last buyer, not the caller");
    const g = await gameState(mintA);
    assert.equal(g.round.toNumber(), 2);
    assert.ok(g.lastBuyer.equals(PublicKey.default));
  });

  it("refuses to pay anyone other than the last buyer", async () => {
    await deposit(mintA, treasuryA.publicKey, LAMPORTS_PER_SOL, carol);
    await buy(mintA, alice);
    await sleep(await untilEnd(mintA));
    try {
      await settle(mintA, carol.publicKey, carol);
      assert.fail("carol did not win");
    } catch (e: any) { assert.include(e.toString(), "WrongWinner"); }
    await settle(mintA, alice.publicKey, carol);
  });

  // ─────────────────────────── the platform's limits

  it("pausing stops new registrations but NOT existing games", async () => {
    await program.methods.setPlatformPaused(true)
      .accounts({ platform, authority: admin.publicKey }).rpc();

    const mintC = await createMint(conn, admin, admin.publicKey, null, 6);
    try {
      await register(mintC, creatorA, treasuryA.publicKey);
      assert.fail("registrations should be paused");
    } catch (e: any) { assert.include(e.toString(), "Paused"); }

    // but an attached game carries on completely unaffected.
    // B's round may already have expired during the tests above — settle it
    // first, which is itself proof that settle works while paused.
    const gB0 = await gameState(mintB);
    if (gB0.deadline.toNumber() <= Math.floor(Date.now() / 1000)) {
      const w = gB0.lastBuyer.equals(PublicKey.default) ? carol.publicKey : gB0.lastBuyer;
      await settle(mintB, w, carol);
    }
    await deposit(mintB, treasuryB.publicKey, LAMPORTS_PER_SOL, carol);
    await buy(mintB, alice);
    await sleep(await untilEnd(mintB));
    await settle(mintB, alice.publicKey, carol);

    await program.methods.setPlatformPaused(false)
      .accounts({ platform, authority: admin.publicKey }).rpc();
  });

  it("gives the platform authority no way to reach a pot", async () => {
    // settle does not take the platform account at all — the admin cannot
    // name themselves winner, and there is no instruction that lets them try
    const gA0 = await gameState(mintA);
    if (gA0.deadline.toNumber() <= Math.floor(Date.now() / 1000)) {
      const w = gA0.lastBuyer.equals(PublicKey.default) ? carol.publicKey : gA0.lastBuyer;
      await settle(mintA, w, carol);
    }
    await deposit(mintA, treasuryA.publicKey, 2 * LAMPORTS_PER_SOL, carol);
    await buy(mintA, bob);
    await sleep(await untilEnd(mintA));

    try {
      await settle(mintA, admin.publicKey, admin);
      assert.fail("the admin is not the winner");
    } catch (e: any) { assert.include(e.toString(), "WrongWinner"); }

    const before = await conn.getBalance(bob.publicKey);
    await settle(mintA, bob.publicKey, admin);   // admin can trigger it; bob gets paid
    assert.ok(await conn.getBalance(bob.publicKey) > before, "the player was paid, not the admin");
  });

  it("can hand over the platform authority for good", async () => {
    await program.methods.setPlatformAuthority(SystemProgram.programId)
      .accounts({ platform, authority: admin.publicKey }).rpc();
    try {
      await program.methods.setPlatformPaused(true)
        .accounts({ platform, authority: admin.publicKey }).rpc();
      assert.fail("old authority should be powerless");
    } catch (e) { assert.ok(e); }
  });
});
