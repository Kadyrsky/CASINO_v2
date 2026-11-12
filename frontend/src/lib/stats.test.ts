import { describe, expect, it } from 'vite-plus/test';
import { bradleyTerry, chanceBestPaired, chanceBestRates, confidence, median, wilson, type PairVote } from './stats';

const votes = (pairs: [string, string, number][]): PairVote[] =>
  pairs.flatMap(([winner, loser, n]) => Array.from({ length: n }, () => ({ winner, loser })));

describe('bradleyTerry', () => {
  it('gives equal strengths without votes', () => {
    const s = bradleyTerry(['a', 'b', 'c'], []);
    expect(s.a).toBeCloseTo(1 / 3, 6);
    expect(s.c).toBeCloseTo(1 / 3, 6);
  });

  it('ranks a clear favourite first and sums to 1', () => {
    const s = bradleyTerry(['a', 'b', 'c'], votes([['a', 'b', 8], ['b', 'a', 2], ['a', 'c', 9], ['c', 'a', 1], ['b', 'c', 5], ['c', 'b', 5]]));
    expect(s.a!).toBeGreaterThan(s.b!);
    expect(s.a!).toBeGreaterThan(s.c!);
    expect(s.a! + s.b! + s.c!).toBeCloseTo(1, 9);
  });

  it('matches the two-item closed form with the prior', () => {
    // 7 wins to 3, plus 0.5 pretend wins each way: strength ratio 7.5 : 3.5.
    const s = bradleyTerry(['a', 'b'], votes([['a', 'b', 7], ['b', 'a', 3]]));
    expect(s.a! / s.b!).toBeCloseTo(7.5 / 3.5, 6);
  });

  it('ranks a version that was never compared directly through the others (transitivity)', () => {
    const s = bradleyTerry(['a', 'b', 'c'], votes([['a', 'b', 6], ['b', 'c', 6]]));
    expect(s.a!).toBeGreaterThan(s.b!);
    expect(s.b!).toBeGreaterThan(s.c!);
  });

  it('ignores votes for unknown versions', () => {
    const s = bradleyTerry(['a', 'b'], [{ winner: 'x', loser: 'a' }]);
    expect(s.a).toBeCloseTo(0.5, 9);
  });
});

describe('chanceBestPaired', () => {
  it('is confident with a lopsided sample and sums to 1', () => {
    const p = chanceBestPaired(['a', 'b', 'c'], votes([['a', 'b', 12], ['a', 'c', 12], ['b', 'c', 6], ['c', 'b', 6]]), 400);
    expect(p.a!).toBeGreaterThan(0.95);
    expect(p.a! + p.b! + p.c!).toBeCloseTo(1, 9);
  });

  it('stays unsure when the votes are split', () => {
    const p = chanceBestPaired(['a', 'b'], votes([['a', 'b', 5], ['b', 'a', 5]]), 400);
    expect(p.a!).toBeGreaterThan(0.2);
    expect(p.a!).toBeLessThan(0.8);
  });

  it('is not certain after a single answer', () => {
    const p = chanceBestPaired(['a', 'b', 'c'], votes([['a', 'b', 1]]), 1000);
    expect(p.a!).toBeGreaterThan(0.5);
    expect(p.a!).toBeLessThan(0.85);
  });

  it('grows more certain as the same preference keeps coming in', () => {
    const few = chanceBestPaired(['a', 'b'], votes([['a', 'b', 3], ['b', 'a', 1]]), 1000);
    const many = chanceBestPaired(['a', 'b'], votes([['a', 'b', 30], ['b', 'a', 10]]), 1000);
    expect(many.a!).toBeGreaterThan(few.a!);
    expect(many.a!).toBeGreaterThan(0.95);
  });

  it('is the same on every run (seeded)', () => {
    const v = votes([['a', 'b', 4], ['b', 'a', 3]]);
    expect(chanceBestPaired(['a', 'b'], v, 200)).toEqual(chanceBestPaired(['a', 'b'], v, 200));
  });
});

describe('wilson', () => {
  it('brackets the observed rate and stays within 0..1', () => {
    const [lo, hi] = wilson(7, 10);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
    expect(wilson(0, 5)[0]).toBe(0);
    expect(wilson(5, 5)[1]).toBe(1);
  });

  it('matches a known value (7 of 10: 0.397 to 0.892)', () => {
    const [lo, hi] = wilson(7, 10);
    expect(lo).toBeCloseTo(0.397, 3);
    expect(hi).toBeCloseTo(0.892, 3);
  });

  it('is the whole range with no data', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe('chanceBestRates', () => {
  it('picks the lowest rate when lower is better', () => {
    const p = chanceBestRates([{ id: 'a', x: 2, n: 40 }, { id: 'b', x: 20, n: 40 }], 'lower', 4000);
    expect(p.a!).toBeGreaterThan(0.99);
  });

  it('is close to a coin flip for equal rates', () => {
    const p = chanceBestRates([{ id: 'a', x: 10, n: 30 }, { id: 'b', x: 10, n: 30 }], 'higher', 8000);
    expect(p.a!).toBeGreaterThan(0.4);
    expect(p.a!).toBeLessThan(0.6);
  });
});

describe('confidence', () => {
  it('uses the thresholds from the test plan', () => {
    expect(confidence(0.97, 40)).toBe('clear');
    expect(confidence(0.85, 40)).toBe('likely');
    expect(confidence(0.6, 40)).toBe('close');
    expect(confidence(0.99, 4)).toBe('early');
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
