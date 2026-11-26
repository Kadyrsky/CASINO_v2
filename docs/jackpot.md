# The casino-wide jackpot

Soul Reels has **one progressive jackpot for the whole casino**. Every losing spin, by anyone, adds a little to it,
everyone sees the same amount roll up live, and five wilds on a line win all of it.

## The rules

* **What feeds it.** A paid spin that wins back less than its stake adds **2% of what it lost** (the stake minus the
  win), rounded up to a cent, so every losing spin adds at least 0.01 NTK. Free spins, the spin that opens the rift
  bonus (its win comes in the bonus) and the spin that hits the jackpot add nothing.
* **What wins it.** Five wilds on a line (Hidden Kings, or Jokers with the classic symbols). The player gets the whole
  pool, and the next pool starts at the **seed, 5,000 NTK**. If two players hit at the same moment, the first wins the
  pool and the second wins the new one; a pool is never paid twice.
* **How likely.** About one spin in 840,000 (free spins included): each of the 10 lines needs a wild on all five reels,
  and the reels have 1, 2, 1, 2 and 1 wilds in 32 stops.
* **What it costs the house.** Three paid spins in four lose; the 2% share then comes to about 1.45% of everything
  staked, which goes back to players through the jackpot (the slot's own return is 93–98% without it). It used to be 1%
  of every paid stake, won or lost.
* **Any bet can win it.** The chance doesn't depend on the bet, so it is worth most on small bets. Real progressives
  usually need the maximum bet, or scale the chance with the bet; with play money, everyone gets the full pool.

The rate and the seed are in the `jackpot_pools` row (`contribution_bp`, `seed_amount`). A new rate counts from the next
spin; a new seed from the next pool.

## Where it lives and who decides

The core decides everything, the browser only shows it:

* The pool is a row in `jackpot_pools` (one per slot game; Soul Reels is the only one). `generation` numbers the pools,
  one more each time a pool is won. `jackpot_wins` keeps every win: the pool's generation, the round, the player and the
  amount, with **(game, generation) as its primary key**, so a pool can have only one winner.
* The spin is decided on the core by the provably fair RNG (`SlotService`, `SlotMachine`); `Paytable` sees a jackpot
  line. The page never sends an outcome or an amount, only the bet.
* `JackpotService` adds the shares and pays the wins; `JackpotFeed` tells everyone.

## Many spins at once

A spin is one transaction: the stake, the round, the line wins, the jackpot share or payout and the pool commit
together or not at all.

* **Shares are atomic.** `UPDATE jackpot_pools SET amount = amount + share`, so concurrent spins can't lose each
  other's shares. It is the **last statement of the spin**, so the casino-wide row is locked only for the end of each
  spin's transaction.
* **One winner per pool.** A hit first locks the pool (`SELECT … FOR UPDATE` waits for any spin still holding it and
  then reads the latest amount), resets it to the seed and moves it to the next generation, then pays exactly what it
  read and records the win. A second hit at the same time waits, and then wins the next pool.
* The old reset (`UPDATE … FROM jackpot_pools old … RETURNING old.amount`) read the amount from before it waited for
  the lock. It was only safe after the paid spin's own share had locked the row first, and free spins add no share, so
  two hits at once could both be paid the same pool. With that query, six simultaneous hits in `JackpotIT` were each
  paid the full pool; now one is.

## Everyone sees the same amount

* `GET /api/slots/jackpot` (public): `{amount, generation, seed, contributionPercent, lastWin}`; the last win has the
  amount, the pool's generation, the winner's masked name (`l***n`, the first and last letter) and when.
* WebSocket topic **`jackpot`** (public, no login): `JACKPOT {gameId, amount, generation}` at most twice a second while
  people play, and `JACKPOT_WON {gameId, amount, generation, lastWin}` as soon as a hit commits. Messages leave only
  after the commit (`WsHub`), and a reconnecting page gets what it missed (`lastSeq`).
* A spin's result has `jackpot: {amount, generation, added}` when the spin changed the pool, so the player sees their
  own share at once ("+0.02 to the jackpot" under "No win this time.").

Updates can arrive late or out of order (a tick and a win travel separately, and the spin's own result races both), so
the page keeps the newest: a later generation, or more in the same one. A pool only grows until it is won.

## The animation

* **The meter** (slots page, `components/jackpot.tsx`): the amount is an odometer, each digit a wheel that rolls
  forward to the next value (through 9 to 0, like a real one) and back down when a new pool starts. Each gain pulses the
  amount and floats a "+0.07" beside it.
* **Someone else's hit**: the meter glows, coins burst out of it, and it holds the pool they won for a few seconds,
  "Jackpot hit! Won by l***n!", then rolls down to the new pool. On other pages a note at the top says who hit it and
  for how much, and links to the slots.
* **Your hit**: a full-screen celebration, with the existing `jackpot` sound: turning rays, a burst of coins, the win
  counting up, and Collect. While your spin is in the air the meter holds back any new pool, so your own hit isn't given
  away by the meter, or shown as someone else's, before the reels stop.
* **Every theme**: all colours come from the theme's accent (`--color-gold-300` … `600`): amber for the Hidden King,
  sapphire for the Archmother, lime for Deadlock.
* **Reduced motion** (`prefers-reduced-motion`): the digits change without rolling, nothing pulses, flies or turns,
  someone else's hit is a steady glow, and your win shows in full at once.

The logic is `lib/jackpotMeter.ts` (no Solid, tested on its own), the live store `lib/jackpot.ts`, the look
`components/jackpot.tsx` and `components/jackpot.css`, and the note on other pages `components/JackpotAlerts.tsx`.

## Tests

* `JackpotServiceTest`: what a spin lost, masked names, which of two pools is newer, and that the seed pair the
  integration test uses really lands five wilds.
* `JackpotIT` (real Postgres and Redis): eight players spinning at once add up exactly; a hit pays the whole pool,
  starts the next at the seed and is recorded; six hits at once (with losing spins in between) pay each pool once and
  nothing is lost or made; an anonymous WebSocket sees the pool grow and the win, without the winner's id.
* `frontend/src/lib/jackpotMeter.test.ts`: the counter (late ticks never roll it back, a new pool is a hit, the
  player's own hit is never someone else's, held updates during a spin), the odometer's wheels and the count-up.
* `frontend/e2e/jackpot.spec.ts` (Playwright, against the mock core): the meter rolling up, someone else's hit on the
  meter and on another page, the player's own celebration, and reduced motion.

To look at it without the real core, run the mock core and the dev server (`frontend/e2e/mock-core.mjs`): other
players lose all the time, someone else hits the jackpot every few minutes or at once with
`POST /api/mock/jackpot/hit`, and you can log in with any name and password. A spin at 10.00 a line always hits the
jackpot there.
