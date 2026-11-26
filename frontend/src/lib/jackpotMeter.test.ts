import { describe, expect, it } from 'vite-plus/test';
import {
  countUp,
  idleMeter,
  isFresh,
  mergePool,
  odometerCells,
  receive,
  spinEnd,
  spinStart,
  wheelTarget,
  type Effect,
  type JackpotWin,
  type Meter,
  type Update,
} from './jackpotMeter';

const tick = (amount: number, generation: number, live = true): Update => ({ pool: { amount, generation }, live });
const win = (amount: number, generation: number): JackpotWin => ({ amount, generation, winner: 'l***n', at: '2026-11-26T12:00:00Z' });

/** Feeds updates in order, collecting every effect. */
function feed(m: Meter, ...updates: Update[]): [Meter, Effect[]] {
  const all: Effect[] = [];
  for (const u of updates) {
    const [next, fx] = receive(m, u);
    m = next;
    all.push(...fx);
  }
  return [m, all];
}

describe('mergePool', () => {
  it('takes the first pool as it is', () => {
    expect(mergePool(null, { amount: 5000, generation: 1 })).toEqual({ pool: { amount: 5000, generation: 1 }, change: { kind: 'first' } });
  });

  it('grows by whole cents', () => {
    const r = mergePool({ amount: 5000.1, generation: 1 }, { amount: 5000.3, generation: 1 });
    expect(r.change).toEqual({ kind: 'grew', by: 0.2 });
    expect(r.pool.amount).toBe(5000.3);
  });

  it('never goes back for a late tick of the same pool or an earlier pool', () => {
    const shown = { amount: 5012.5, generation: 3 };
    expect(mergePool(shown, { amount: 5012.4, generation: 3 })).toEqual({ pool: shown, change: { kind: 'stale' } });
    expect(mergePool(shown, { amount: 90_000, generation: 2 })).toEqual({ pool: shown, change: { kind: 'stale' } });
    expect(mergePool(shown, { amount: 5012.5, generation: 3 }).change).toEqual({ kind: 'same' });
  });

  it('sees a later pool, even a smaller one, as the shown pool being won', () => {
    const r = mergePool({ amount: 12_345.67, generation: 3 }, { amount: 5000, generation: 4 });
    expect(r.change).toEqual({ kind: 'won', previous: { amount: 12_345.67, generation: 3 } });
    expect(r.pool).toEqual({ amount: 5000, generation: 4 });
  });
});

describe('the meter', () => {
  const start = feed(idleMeter, tick(5000, 3, false))[0];

  it('pulses for every gain, and ignores ticks that arrive late', () => {
    const [m, fx] = feed(start, tick(5000.02, 3), tick(5000.01, 3), tick(5000.05, 3), tick(5000.05, 3));
    expect(fx).toEqual([{ kind: 'grew', by: 0.02 }, { kind: 'grew', by: 0.03 }]);
    expect(m.pool).toEqual({ amount: 5000.05, generation: 3 });
  });

  it("shows someone else's hit when the new pool arrives, and their name when the JACKPOT_WON follows", () => {
    const [m, fx] = feed(start, tick(5000, 4), { pool: { amount: 5000, generation: 4 }, win: win(5000, 3), live: true });
    expect(fx).toEqual([
      { kind: 'hit', previous: { amount: 5000, generation: 3 }, win: null },
      { kind: 'winner', win: win(5000, 3) },
    ]);
    expect(m.pool).toEqual({ amount: 5000, generation: 4 });
  });

  it('shows the hit with its winner at once when the JACKPOT_WON comes first', () => {
    const [, fx] = feed(start, { pool: { amount: 5000, generation: 4 }, win: win(5000, 3), live: true }, tick(5000, 4));
    expect(fx).toEqual([{ kind: 'hit', previous: { amount: 5000, generation: 3 }, win: win(5000, 3) }]);
  });

  it('only moves on for a pool won while the page was away (a page load or a replay)', () => {
    const [m, fx] = feed(start, tick(5000.5, 4, false), { pool: { amount: 5000.5, generation: 4 }, win: win(5000, 3), live: false });
    expect(fx).toEqual([]);
    expect(m.pool).toEqual({ amount: 5000.5, generation: 4 });
  });

  it("holds a new pool while the player's spin is in the air, then shows it as someone else's hit", () => {
    let m = spinStart(start);
    let fx: Effect[];
    [m, fx] = feed(m, tick(5000.02, 3), { pool: { amount: 5000, generation: 4 }, win: win(5000.02, 3), live: true });
    expect(fx).toEqual([{ kind: 'grew', by: 0.02 }]); // the pool keeps growing meanwhile
    expect(m.pool).toEqual({ amount: 5000.02, generation: 3 });
    // The player's spin lost and added 0.02, before the other player's hit
    [m, fx] = spinEnd(m, { jackpotWin: 0, jackpot: { amount: 5000.02, generation: 3, added: 0.02 } });
    expect(fx).toEqual([{ kind: 'hit', previous: { amount: 5000.02, generation: 3 }, win: win(5000.02, 3) }]);
    expect(m).toEqual({ pool: { amount: 5000, generation: 4 }, spinning: false, held: [], mine: null });
  });

  it("celebrates the player's own hit, and never shows it as someone else's, whichever message comes first", () => {
    let m = spinStart(start);
    let fx: Effect[];
    [m, fx] = feed(m, { pool: { amount: 5000, generation: 4 }, win: win(5000, 3), live: true }, tick(5000, 4));
    expect(fx).toEqual([]);
    [m, fx] = spinEnd(m, { jackpotWin: 5000, jackpot: { amount: 5000, generation: 4, added: 0 } });
    expect(fx).toEqual([{ kind: 'mine', amount: 5000, generation: 3 }]);
    [m, fx] = feed(m, { pool: { amount: 5000, generation: 4 }, win: win(5000, 3), live: true }, tick(5000.01, 4));
    expect(fx).toEqual([{ kind: 'grew', by: 0.01 }]);
    expect(m.mine).toBe(3);
  });

  it("doesn't roll back to a spin's own pool when others' ticks already passed it", () => {
    let m = spinStart(start);
    [m] = feed(m, tick(5000.07, 3));
    const [after, fx] = spinEnd(m, { jackpotWin: 0, jackpot: { amount: 5000.02, generation: 3, added: 0.02 } });
    expect(fx).toEqual([]);
    expect(after.pool).toEqual({ amount: 5000.07, generation: 3 });
  });

  it('lets go of what it held when the spin fails', () => {
    let m = spinStart(start);
    [m] = feed(m, tick(5000, 4));
    const [after, fx] = spinEnd(m, null);
    expect(fx).toEqual([{ kind: 'hit', previous: { amount: 5000, generation: 3 }, win: null }]);
    expect(after.spinning).toBe(false);
  });
});

describe('isFresh', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  it('treats the last minute as news and anything older as a replay', () => {
    expect(isFresh('2026-11-26T11:59:30Z', now)).toBe(true);
    expect(isFresh('2026-11-26T11:58:30Z', now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(true);
  });
});

describe('odometerCells', () => {
  const text = (amount: number) =>
    odometerCells(amount)
      .map((c) => ('digit' in c ? String(c.digit) : c.mark))
      .reverse()
      .join('');

  it('reads the amount from the right, two decimals and groups of three', () => {
    expect(odometerCells(1234.5)).toEqual([{ digit: 0 }, { digit: 5 }, { mark: '.' }, { digit: 4 }, { digit: 3 }, { digit: 2 }, { mark: ',' }, { digit: 1 }]);
    expect(text(5000)).toBe('5,000.00');
    expect(text(0)).toBe('0.00');
  });

  it('keeps every place the same kind of cell as the amount gains digits', () => {
    const kinds = (amount: number) => odometerCells(amount).map((c) => ('digit' in c ? 'd' : c.mark));
    const widest = kinds(123_456_789.99);
    for (const amount of [0.01, 9.99, 10, 999.99, 1000, 99_999.99, 100_000, 1_234_567.89]) {
      const k = kinds(amount);
      expect(k).toEqual(widest.slice(0, k.length));
    }
  });
});

describe('wheelTarget', () => {
  it('rolls forward through 9 when the amount grows', () => {
    expect(wheelTarget(3, 5, true)).toBe(5);
    expect(wheelTarget(7, 2, true)).toBe(12);
    expect(wheelTarget(9, 0, true)).toBe(10);
    expect(wheelTarget(4, 4, true)).toBe(4);
  });

  it('rolls straight back for a new, smaller pool', () => {
    expect(wheelTarget(7, 2, false)).toBe(2);
    expect(wheelTarget(2, 7, false)).toBe(7);
  });
});

describe('countUp', () => {
  it('climbs fast, slows down and lands exactly on the win', () => {
    const steps = [0, 300, 600, 1200, 1800, 2399, 2400, 5000].map((t) => countUp(12_345.67, t, 2400));
    expect(steps[0]).toBe(0);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
    expect(steps[3]!).toBeGreaterThan(12_345.67 * 0.8); // most of it in the first half
    expect(steps.at(-2)).toBe(12_345.67);
    expect(steps.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6)).toBe(true); // whole cents
  });
});
