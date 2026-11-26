/**
 * How a visitor is given a version of an experiment: drawn from their visitor id, so it needs no server call and stays
 * the same on every visit. Plain functions, tested in abAssign.test.ts; experiments.ts uses them.
 *
 * Versions can be added to an experiment that is already running (the Christmas theme, the Christmas sounds). A
 * visitor who was already given a version must keep it, or their theme would change under them and the dashboard
 * (which counts each visitor under the version first given) would be wrong. So the draw has rounds: every visitor
 * belongs to the round in which they first came, a version or an experiment added later says `since` which round, and
 * a visitor is drawn only from the versions of their round. Visitors from round 1 get exactly the version they had.
 */

/** The current round. Raise it when adding a version to a running experiment, and give the version `since`. */
export const ROUND = 2;

export interface Drawable {
  key: string;
  /** The round the experiment started in (1 if not given). */
  since?: number;
  variants: { id: string; pickOnly?: boolean; since?: number }[];
}

/** FNV-1a: a stable number from a text. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The versions a visitor of `round` is drawn from, in order. An experiment newer than the visitor uses its own round. */
export function pool(e: Drawable, round: number): string[] {
  const r = Math.max(round, e.since ?? 1);
  return e.variants.filter((v) => !v.pickOnly && (v.since ?? 1) <= r).map((v) => v.id);
}

/** The version a visitor is given. */
export function draw(e: Drawable, visitorId: string, round: number): string {
  const ids = pool(e, round);
  return ids[hash(`${visitorId}:${e.key}`) % ids.length]!;
}

/**
 * A visitor's round: the one stored for them, or, the first time it is asked, round 1 for someone who already had a
 * visitor id (they came before rounds existed) and the current round for someone new.
 */
export function roundOf(stored: unknown, hadVisitorId: boolean): number {
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 && stored <= ROUND) return stored;
  return hadVisitorId ? 1 : ROUND;
}
