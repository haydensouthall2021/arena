# The Throne

A single seat on Solana. Whoever holds it when the clock hits zero takes the
whole pot. Anyone can take the seat by burning tokens.

**Nothing here can take your money.** The pot lives at a program-derived
address with no private key in existence — not the deployer's, not anyone's.
The only instruction that moves SOL out is `settle`, it can only pay the
round's holder, and anybody at all can call it.

---

## How it works

1. Trading fees on the paired token are pushed into the pot, in SOL
2. A clock runs down. Whoever holds the seat at zero takes the pot
3. Taking the seat **burns tokens** against the mint — they are destroyed
4. Each take **adds 30 seconds** to the clock and costs 15% more than the last
5. Taking the seat grants **20 seconds of immunity**

### The cost tracks the remaining supply

A take costs a fixed *share* of whatever supply is left, not a fixed number of
tokens. Burn half the supply and a take costs half as many tokens. The game is
as playable at 99% burned as on day one, and a large holder cannot price
everyone else out — their stack is a share of supply too.

| Supply left | Cost at 0.25% |
|---|---|
| 1,000,000,000 | 2,500,000 |
| 100,000,000 | 250,000 |
| 10,000,000 | 25,000 |

---

## What the program can and cannot do

| Instruction | Who can call it | What it does |
|---|---|---|
| `initialize` | deployer, once | Sets round length, immunity, floor, step, cut |
| `deposit_fees` | **anyone** | Adds SOL to the pot, skims the creator cut |
| `take_throne` | anyone | Burns tokens, takes the seat, extends the clock |
| `settle` | **anyone** | Pays the pot to the round's holder, starts the next |
| `set_paused` | authority | Stops deposits and takes. **Cannot stop `settle`.** |
| `set_authority` | authority | Hands over or permanently gives up the key |

Things worth checking in the source yourself:

- **`settle` pays `throne.holder`, never the caller.** There is nothing to gain
  by racing to call it — only a new round to start. If the keeper dies, any
  player can settle and the winner is still paid.
- **`set_paused` deliberately does not gate `settle`.** A lost or hostile
  authority key cannot trap a round's pot.
- **Burned tokens use `token::burn` against the mint.** They are destroyed, not
  forwarded to a treasury wallet.
- **The round ceiling cannot be walked past.** `max_end` is fixed when a round
  starts, and immunity is clamped to the round end so repeated late takes cannot
  extend it indefinitely.
- **`take_throne` takes a `max_cost`.** If the price steps up before your
  transaction lands, it fails rather than overcharging you.

### The cost is priced in tokens, not SOL — on purpose

Pricing a take as a share of the pot would need an oracle to convert SOL to
tokens, and an oracle can be manipulated for a single block and the pot drained.
So the cost is a share of supply plus a per-take ratchet. Competition finds the
level with nobody trusted to report a price.

---

## Build and test

```bash
npm install
anchor build          # prints your program ID — put it in lib.rs and Anchor.toml
anchor test           # 13 tests against a local validator
```

## Launch

```bash
TREASURY=<fee-wallet> npx tsx scripts/launch.ts
```

Creates the mint, issues the supply once, **revokes the mint authority**, and
founds the Throne. Writes the addresses to `launch.json`.

## Keeper

```bash
npx tsx scripts/keeper.ts
```

Settles rounds the moment they end so nobody has to press anything. It cannot
redirect a lamport — `settle` always pays the holder.

## Site

```bash
cp app/config.example.json app/config.json   # point it at your program
cp target/idl/throne.json app/throne.json
node app/serve.js
```

One static HTML file. Reads the chain, holds nothing, can be hosted anywhere.

---

## Honest limits

**Not audited.** The program is small and cheap to audit. It holds real SOL. Do
this before mainnet.

**The keeper is the one part that is not trustless.** Creator fees land in a
wallet you control before being pushed into the pot. Publish that address so the
sweeps can be checked — the transactions are public either way.

**Parameters are fixed at launch.** Round length, immunity, floor, step and cut
cannot be changed afterwards, deliberately, so nobody can tilt the game
mid-flight.

**Nothing on a blockchain runs on a timer.** "Automatic" payout means a keeper
sends the transaction. The design makes that permissionless so it does not
matter who does.

## Licence

MIT.
