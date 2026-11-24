/**
 * The 3D view's interiors: the floors of the map's tunnels, halls and covered courts (mapModel.ts), where heroes walk
 * that no camera sees. A hero standing in one opens it: that interior's floor around the hero, raised to a slice above
 * head height, is drawn into a depth map from the camera (mapModelRenderer.ts), and whatever lies between the camera
 * and that slice is left out. The streets or roofs over the hero, the near walls and the buildings in front go; the
 * floor, the far walls and the hero's surroundings stay, from any angle. Other interiors (the storey above, the hall
 * next door) stay covered.
 */
import { mapHeight, type MapModel } from './mapModel';

/** How far around a hero an interior opens, in world units (about a hall). */
export const OPEN_RADIUS = 1400;
/** How high above an interior's floor the slice lies, in world units (heroes are about 80 tall). */
export const SLICE = 110;
/** Floors open around a hero within this height of its own floor, world units: ramps, not the storey above or below. */
export const BAND = 250;
/** A hero stands in an interior when its floor is at most this far below the hero's feet (a step or a hop), in world
 * units, or a little above them (the nav mesh's polygons are rough). */
const BELOW = 140;
const ABOVE = 60;
/** Grid cell of the index, map units. */
const CELL = 8;

/** Where a hero stands in an interior: the height (map units) of the floor under it, and which interior that is. */
export interface Footing {
  floor: number;
  region: number;
}

/** A hero in an interior, opening it: its map point, and its footing. */
export interface Opening extends Footing {
  x: number;
  y: number;
}

/** Floats per vertex of the slice triangles: map point and height, then the opening hero's map point and radius. */
export const SLICE_STRIDE = 6;

const indexes = new WeakMap<MapModel, InteriorIndex>();

/** The interiors' floor triangles on a grid, for finding the floor under a hero and the floors around one. */
export class InteriorIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly lo: Float32Array;
  private readonly hi: Float32Array;
  private readonly n: number;
  private readonly band: number;
  private readonly below: number;
  private readonly above: number;
  readonly radius: number;
  readonly slice: number;

  private constructor(private readonly model: MapModel) {
    const { positions: P, indices: I } = model.interiors;
    const count = I.length / 3;
    this.lo = new Float32Array(count);
    this.hi = new Float32Array(count);
    this.n = Math.ceil(1000 / CELL);
    this.radius = mapHeight(model, OPEN_RADIUS);
    this.slice = mapHeight(model, SLICE);
    this.band = mapHeight(model, BAND);
    this.below = mapHeight(model, BELOW);
    this.above = mapHeight(model, ABOVE);
    for (let t = 0; t < count; t++) {
      const [a, b, c] = [I[t * 3]! * 3, I[t * 3 + 1]! * 3, I[t * 3 + 2]! * 3];
      this.lo[t] = Math.min(P[a + 2]!, P[b + 2]!, P[c + 2]!);
      this.hi[t] = Math.max(P[a + 2]!, P[b + 2]!, P[c + 2]!);
      const [x0, x1] = [this.cell(Math.min(P[a]!, P[b]!, P[c]!)), this.cell(Math.max(P[a]!, P[b]!, P[c]!))];
      const [y0, y1] = [this.cell(Math.min(P[a + 1]!, P[b + 1]!, P[c + 1]!)), this.cell(Math.max(P[a + 1]!, P[b + 1]!, P[c + 1]!))];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const key = y * this.n + x;
          const list = this.cells.get(key);
          if (list) list.push(t);
          else this.cells.set(key, [t]);
        }
      }
    }
  }

  /** The index of a model's interiors, made once per model; null when it has none (files before version 3). */
  static of(model: MapModel): InteriorIndex | null {
    if (!model.interiors.indices.length) return null;
    let index = indexes.get(model);
    if (!index) {
      index = new InteriorIndex(model);
      indexes.set(model, index);
    }
    return index;
  }

  private cell(v: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor(v / CELL)));
  }

  /** Height of triangle t at map point (x, y), or null when the point is outside it (seen from above). */
  private heightIn(t: number, x: number, y: number): number | null {
    const { positions: P, indices: I } = this.model.interiors;
    const [a, b, c] = [I[t * 3]! * 3, I[t * 3 + 1]! * 3, I[t * 3 + 2]! * 3];
    const den = (P[b + 1]! - P[c + 1]!) * (P[a]! - P[c]!) + (P[c]! - P[b]!) * (P[a + 1]! - P[c + 1]!);
    if (!den) return null;
    const wa = ((P[b + 1]! - P[c + 1]!) * (x - P[c]!) + (P[c]! - P[b]!) * (y - P[c + 1]!)) / den;
    const wb = ((P[c + 1]! - P[a + 1]!) * (x - P[c]!) + (P[a]! - P[c]!) * (y - P[c + 1]!)) / den;
    const wc = 1 - wa - wb;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) return null;
    return wa * P[a + 2]! + wb * P[b + 2]! + wc * P[c + 2]!;
  }

  /**
   * The interior floor that a hero at map point (x, y), height h, stands on: the highest floor there from a hop below
   * its feet to a little above them. Null when the hero isn't in an interior.
   */
  footing(x: number, y: number, h: number): Footing | null {
    let best: Footing | null = null;
    for (const t of this.cells.get(this.cell(y) * this.n + this.cell(x)) ?? []) {
      if (this.hi[t]! < h - this.below || this.lo[t]! > h + this.above) continue;
      const z = this.heightIn(t, x, y);
      if (z != null && z >= h - this.below && z <= h + this.above && (!best || z > best.floor)) {
        best = { floor: z, region: this.model.interiors.regions[t]! };
      }
    }
    return best;
  }

  /**
   * The slices over the interiors that the heroes in them open: each opening's own interior within OPEN_RADIUS (and
   * BAND of its floor), raised by SLICE, as triangles of SLICE_STRIDE floats a vertex. The renderer cuts each vertex's
   * triangle to the circle its last three floats give.
   */
  slices(openings: Opening[]): Float32Array {
    const { positions: P, indices: I, regions: R } = this.model.interiors;
    const out: number[] = [];
    const seen = new Set<number>();
    const r = this.radius;
    for (const o of openings) {
      seen.clear();
      for (let y = this.cell(o.y - r); y <= this.cell(o.y + r); y++) {
        for (let x = this.cell(o.x - r); x <= this.cell(o.x + r); x++) {
          for (const t of this.cells.get(y * this.n + x) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            if (R[t] !== o.region || this.hi[t]! < o.floor - this.band || this.lo[t]! > o.floor + this.band) continue;
            for (let k = 0; k < 3; k++) {
              const v = I[t * 3 + k]! * 3;
              out.push(P[v]!, P[v + 1]!, P[v + 2]! + this.slice, o.x, o.y, r);
            }
          }
        }
      }
    }
    return new Float32Array(out);
  }
}

/**
 * Openings equal to within 0.4 map units (about 9 world units, a fraction of an opening's 1400): a hero walking on
 * redraws the map some 30 times a second rather than every frame.
 */
export function sameOpenings(a: Opening[], b: Opening[]): boolean {
  return (
    a.length === b.length &&
    a.every((o, i) => {
      const p = b[i]!;
      return o.region === p.region && Math.abs(o.x - p.x) < 0.4 && Math.abs(o.y - p.y) < 0.4 && Math.abs(o.floor - p.floor) < 0.4;
    })
  );
}
