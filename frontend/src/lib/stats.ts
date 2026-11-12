/**
 * Statistics for the A/B dashboard, written for small samples (about a hundred visitors): instead of a pass/fail
 * significance test, every number comes with "how sure can we be", in words people can act on.
 *
 * - Taste test (paired votes): a Bradley–Terry model ranks the versions from all head-to-head answers at once, and
 *   a bootstrap (re-running it on resampled votes) says how often each version comes out on top.
 * - Between visitors (rates like "turned the music off"): Beta posteriors, and the chance each version is best.
 */

/** One answered pair. */
export interface PairVote {
  winner: string;
  loser: string;
}

/** A small seeded random generator (mulberry32), so the dashboard shows the same numbers on every refresh. */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bradley–Terry strengths (summing to 1): the chance i beats j is s_i / (s_i + s_j). Fitted with Hunter's MM
 * algorithm. `prior` adds that many pretend wins each way to every pair, which keeps a version with no wins yet
 * from dropping to zero and pulls small samples gently towards "all equal".
 */
export function bradleyTerry(items: string[], votes: PairVote[], prior = 0.5): Record<string, number> {
  const k = items.length;
  const index = new Map(items.map((id, i) => [id, i]));
  const wins = Array.from({ length: k }, () => prior * (k - 1));
  const games = Array.from({ length: k }, () => Array.from({ length: k }, () => 2 * prior));
  for (const v of votes) {
    const w = index.get(v.winner);
    const l = index.get(v.loser);
    if (w == null || l == null || w === l) continue;
    wins[w]! += 1;
    games[w]![l]! += 1;
    games[l]![w]! += 1;
  }
  let s = Array.from({ length: k }, () => 1 / k);
  for (let iter = 0; iter < 500; iter++) {
    const next = s.map((si, i) => {
      let denom = 0;
      for (let j = 0; j < k; j++) if (j !== i) denom += games[i]![j]! / (si + s[j]!);
      return denom > 0 ? wins[i]! / denom : si;
    });
    const total = next.reduce((a, b) => a + b, 0);
    const normalized = next.map((x) => x / total);
    const change = Math.max(...normalized.map((x, i) => Math.abs(x - s[i]!)));
    s = normalized;
    if (change < 1e-10) break;
  }
  return Object.fromEntries(items.map((id, i) => [id, s[i]!]));
}

/**
 * How often each version ranks first when the answers are simulated again from the fitted model (a parametric
 * bootstrap): for every pair, as many answers as were given, each won with the model's probability, then refitted.
 * Unlike resampling the answers themselves, this stays unsure with few answers: a single 1–0 is about 70%, not 100%.
 */
export function chanceBestPaired(items: string[], votes: PairVote[], rounds = 1000, seed = 7): Record<string, number> {
  const best = Object.fromEntries(items.map((id) => [id, 0]));
  const known = votes.filter((v) => items.includes(v.winner) && items.includes(v.loser) && v.winner !== v.loser);
  if (!known.length || items.length < 2) return Object.fromEntries(items.map((id) => [id, 1 / Math.max(1, items.length)]));
  const fit = bradleyTerry(items, known);
  const pairs = new Map<string, { a: string; b: string; n: number }>();
  for (const v of known) {
    const [a, b] = [v.winner, v.loser].sort() as [string, string];
    const key = `${a}|${b}`;
    pairs.set(key, { a, b, n: (pairs.get(key)?.n ?? 0) + 1 });
  }
  const random = rng(seed);
  for (let r = 0; r < rounds; r++) {
    const sample: PairVote[] = [];
    for (const { a, b, n } of pairs.values()) {
      const pA = fit[a]! / (fit[a]! + fit[b]!);
      for (let i = 0; i < n; i++) sample.push(random() < pA ? { winner: a, loser: b } : { winner: b, loser: a });
    }
    const s = bradleyTerry(items, sample);
    const top = Math.max(...items.map((id) => s[id]!));
    const leaders = items.filter((id) => s[id]! >= top - 1e-12);
    for (const id of leaders) best[id]! += 1 / leaders.length;
  }
  return Object.fromEntries(items.map((id) => [id, best[id]! / rounds]));
}

/** 95% Wilson interval of a proportion (better than ±1.96·SE for small counts). */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function normal(random: () => number): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) by Marsaglia and Tsang; shape ≥ 1 here (Beta posteriors with a uniform prior). */
function gamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** A draw from Beta(a, b). */
export function beta(a: number, b: number, random: () => number): number {
  const x = gamma(a, random);
  return x / (x + gamma(b, random));
}

/**
 * The chance each version has the truly highest (or lowest) rate, given `x` of `n` visitors: draws each rate from
 * its Beta(1 + x, 1 + n − x) posterior many times and counts the winners.
 */
export function chanceBestRates(
  arms: { id: string; x: number; n: number }[],
  better: 'higher' | 'lower',
  draws = 20000,
  seed = 11,
): Record<string, number> {
  const best = Object.fromEntries(arms.map((a) => [a.id, 0]));
  if (arms.length < 2) return Object.fromEntries(arms.map((a) => [a.id, 1]));
  const random = rng(seed);
  for (let i = 0; i < draws; i++) {
    let top = arms[0]!.id;
    let topValue = better === 'higher' ? -1 : 2;
    for (const a of arms) {
      const r = beta(1 + a.x, 1 + a.n - a.x, random);
      if (better === 'higher' ? r > topValue : r < topValue) {
        topValue = r;
        top = a.id;
      }
    }
    best[top]! += 1;
  }
  return Object.fromEntries(arms.map((a) => [a.id, best[a.id]! / draws]));
}

export type Confidence = 'clear' | 'likely' | 'close' | 'early';

/**
 * What a chance-of-being-best means for a decision, decided before the test (docs/ab-testing.md):
 * 95%+ clear, 80%+ likely, else too close to call; fewer than `minVotes` answers is too early to say.
 */
export function confidence(chanceBest: number, votes: number, minVotes = 10): Confidence {
  if (votes < minVotes) return 'early';
  if (chanceBest >= 0.95) return 'clear';
  if (chanceBest >= 0.8) return 'likely';
  return 'close';
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
