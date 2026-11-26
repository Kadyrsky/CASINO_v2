import { describe, expect, it } from 'vitest';
import { draw, hash, pool, ROUND, roundOf, type Drawable } from './abAssign';
import { EXPERIMENTS } from './experimentRegistry';

const theme = EXPERIMENTS.find((e) => e.key === 'theme')!;
const sfx = EXPERIMENTS.find((e) => e.key === 'sfx_pack')!;
const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

/** How visitors were given a version before rounds existed: the version list without pickOnly ones, by hash. */
const before = (variants: string[], key: string, visitor: string) => variants[hash(`${visitor}:${key}`) % variants.length]!;

describe('the random draw', () => {
  it('gives visitors from before the Christmas versions exactly the theme and sounds they had', () => {
    for (const v of ids(500)) {
      expect(draw(theme, v, 1)).toBe(before(['hidden_king', 'archmother', 'deadlock'], 'theme', v));
      expect(draw(sfx, v, 1)).toBe(before(['deadlock', 'arcade', 'soft'], 'sfx_pack', v));
    }
  });

  it('draws new visitors evenly from every version, the new ones included', () => {
    const counts = new Map<string, number>();
    const visitors = ids(8000);
    for (const v of visitors) counts.set(draw(theme, v, ROUND), (counts.get(draw(theme, v, ROUND)) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(['archmother', 'christmas', 'deadlock', 'hidden_king']);
    for (const n of counts.values()) expect(Math.abs(n / visitors.length - 0.25)).toBeLessThan(0.03);
  });

  it('never gives a pickOnly version, and draws an experiment newer than the visitor from all of it', () => {
    const e: Drawable = { key: 'x', since: 2, variants: [{ id: 'a' }, { id: 'b', pickOnly: true }, { id: 'c' }] };
    expect(pool(e, 1)).toEqual(['a', 'c']);
    for (const v of ids(200)) expect(['a', 'c']).toContain(draw(e, v, 1));
  });

  it('gives every music pack and every version a share', () => {
    for (const e of EXPERIMENTS.filter((x) => x.key.startsWith('music_'))) {
      const seen = new Set(ids(3000).map((v) => draw(e, v, 1)));
      expect(seen).toEqual(new Set(e.variants.map((x) => x.id)));
    }
  });
});

describe('a visitor’s round', () => {
  it('is round 1 for someone who already had a visitor id, the current round for someone new', () => {
    expect(roundOf(null, true)).toBe(1);
    expect(roundOf(null, false)).toBe(ROUND);
  });

  it('keeps the stored round, and ignores nonsense', () => {
    expect(roundOf(1, false)).toBe(1);
    expect(roundOf(ROUND, true)).toBe(ROUND);
    expect(roundOf(ROUND + 1, true)).toBe(1);
    expect(roundOf('2', false)).toBe(ROUND);
  });
});
