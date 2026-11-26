/**
 * The casino-wide jackpot's counter, as plain logic (jackpotMeter.test.ts). The store that feeds it is jackpot.ts, the
 * look components/jackpot.tsx; how the pool works is in docs/jackpot.md. Amounts are tokens with two decimals.
 *
 * Updates come from three places that can arrive in any order: GET /api/slots/jackpot, the "jackpot" WebSocket topic
 * (JACKPOT ticks, at most two a second, and JACKPOT_WON), and the player's own spins. A pool only grows until it is
 * won, and each won pool is followed by the next generation, so the newest of two updates is always clear.
 */

/** The pool as the core reports it. */
export interface PoolState {
  amount: number;
  /** Which pool this is: one more each time a pool is won. */
  generation: number;
}

/** A win as everyone sees it; the core masks the winner's name ("l***n"). */
export interface JackpotWin {
  amount: number;
  /** The pool that was won. */
  generation: number;
  winner: string;
  at: string;
}

/** The jackpot part of a spin's result: the pool after the spin, if the spin changed it. */
export interface SpinJackpot {
  jackpotWin: number;
  jackpot?: { amount: number; generation: number; added: number } | null;
}

export type PoolChange =
  | { kind: 'first' }
  | { kind: 'grew'; by: number }
  | { kind: 'won'; previous: PoolState }
  | { kind: 'same' }
  | { kind: 'stale' };

const cents = (n: number) => Math.round(n * 100);

/** Folds an update into the pool on screen. An earlier pool, or less in the same one, is a late message: no change. */
export function mergePool(shown: PoolState | null, next: PoolState): { pool: PoolState; change: PoolChange } {
  if (!shown) return { pool: next, change: { kind: 'first' } };
  if (next.generation > shown.generation) return { pool: next, change: { kind: 'won', previous: shown } };
  if (next.generation < shown.generation) return { pool: shown, change: { kind: 'stale' } };
  const by = cents(next.amount) - cents(shown.amount);
  if (by > 0) return { pool: next, change: { kind: 'grew', by: by / 100 } };
  return { pool: shown, change: { kind: by === 0 ? 'same' : 'stale' } };
}

// ---------------------------------------------------------------- the meter's state

export interface Meter {
  pool: PoolState | null;
  /** The player's own spin is in the air. */
  spinning: boolean;
  /** New pools that arrived meanwhile: held until the reels stop, as the win might be the player's own. */
  held: Update[];
  /** The pool this player won themselves, so its JACKPOT_WON isn't shown as someone else's win. */
  mine: number | null;
}

export interface Update {
  pool: PoolState;
  win?: JackpotWin | null;
  /** News as it happens. A page load, or messages replayed after a reconnect, only set the amount. */
  live: boolean;
}

export type Effect =
  | { kind: 'grew'; by: number }
  /** Someone else won the pool on screen. `win` is null when the tick came before the JACKPOT_WON. */
  | { kind: 'hit'; previous: PoolState; win: JackpotWin | null }
  /** Who won a pool already shown as hit, and how much. */
  | { kind: 'winner'; win: JackpotWin }
  /** The player hit the jackpot. */
  | { kind: 'mine'; amount: number; generation: number };

export const idleMeter: Meter = { pool: null, spinning: false, held: [], mine: null };

function apply(m: Meter, u: Update): [Meter, Effect[]] {
  const { pool, change } = mergePool(m.pool, u.pool);
  const effects: Effect[] = [];
  const win = u.win ?? null;
  if (change.kind === 'grew') effects.push({ kind: 'grew', by: change.by });
  if (change.kind === 'won') {
    if (u.live && change.previous.generation !== m.mine) {
      effects.push({ kind: 'hit', previous: change.previous, win: win?.generation === change.previous.generation ? win : null });
    }
  } else if (win && u.live && win.generation !== m.mine) {
    effects.push({ kind: 'winner', win });
  }
  return [{ ...m, pool }, effects];
}

/** An update from the core (a tick, a win, a page load). */
export function receive(m: Meter, u: Update): [Meter, Effect[]] {
  if (m.spinning && m.pool && u.pool.generation > m.pool.generation) return [{ ...m, held: [...m.held, u] }, []];
  return apply(m, u);
}

export function spinStart(m: Meter): Meter {
  return { ...m, spinning: true };
}

/** The reels stopped (`spin` is null if the spin failed): the spin's own pool first, then whatever was held. */
export function spinEnd(m: Meter, spin: SpinJackpot | null): [Meter, Effect[]] {
  let state: Meter = { ...m, spinning: false, held: [] };
  const effects: Effect[] = [];
  const pool = spin?.jackpot;
  if (spin && pool) {
    if (spin.jackpotWin > 0) {
      state = { ...state, mine: pool.generation - 1 };
      effects.push({ kind: 'mine', amount: spin.jackpotWin, generation: pool.generation - 1 });
    }
    const [next, fx] = apply(state, { pool: { amount: pool.amount, generation: pool.generation }, live: true });
    state = next;
    effects.push(...fx);
  }
  for (const u of m.held) {
    const [next, fx] = apply(state, u);
    state = next;
    effects.push(...fx);
  }
  return [state, effects];
}

/** A pushed message is news if it was sent in the last minute; replays after a reconnect can be much older. */
export function isFresh(ts: string | undefined, now: number, maxAgeMs = 60_000): boolean {
  const sent = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(sent) || now - sent <= maxAgeMs;
}

// ---------------------------------------------------------------- the odometer

const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type OdometerCell = { digit: number } | { mark: string };

/**
 * The amount as odometer cells, from the right: "1,234.50" is 0 5 . 4 3 2 , 1. Counted from the right, a place always
 * holds the same kind of cell (two decimals, the point, then groups of three), so every wheel keeps its place when
 * the amount gains a digit.
 */
export function odometerCells(amount: number): OdometerCell[] {
  const text = fmt.format(Math.max(0, amount));
  const out: OdometerCell[] = [];
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text.charAt(i);
    out.push(ch >= '0' && ch <= '9' ? { digit: ch.charCodeAt(0) - 48 } : { mark: ch });
  }
  return out;
}

/**
 * Where a wheel (0–9, then 0–9 again) rolls to for its next digit, from where it rests (0–9). Going up it always rolls
 * forward, onto the second strip past 9 (7 → 2 rolls 8, 9, 0, 1, 2); going down (a new pool) it rolls straight back.
 * Once there it settles at the same digit on the first strip, without moving.
 */
export function wheelTarget(from: number, digit: number, rising: boolean): number {
  return rising && digit < from ? digit + 10 : digit;
}

/** The celebration's count-up: `to` after `duration` ms, fast at first and then slowing down, in whole cents. */
export function countUp(to: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return to;
  const t = Math.max(0, elapsed) / duration;
  return Math.floor(cents(to) * (1 - (1 - t) ** 3)) / 100;
}
