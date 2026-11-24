/**
 * The ground and buildings of the realtime map's 2.5D view, made from deadlock-api's minimap image. Its dark, half
 * see-through areas are the streets (darker against the walls); the clear holes inside them are buildings, and the
 * clear area around them is outside the map. The outlines of the buildings and of the whole map are traced
 * (marching squares) and straightened (Douglas-Peucker) into wall segments.
 *
 * Positions are in map units, like the 2D map's: 0–1000, x right and y down.
 */
import { MAP_SIZE } from './mapCamera';

/** How tall the buildings stand above the streets, in map units. */
export const BUILDING_HEIGHT = 13;
/** How far the map's edge reaches down below the streets, in map units. */
export const EDGE_DEPTH = 26;

/** Minimap alpha (0–255) from which a pixel is street. */
const STREET_ALPHA = 90;
/** Street alpha in the open and right against a wall (the image's own shading). */
const OPEN_ALPHA = 178;
const WALL_ALPHA = 223;
/** Clear holes with fewer pixels than this are specks in the image, not buildings. */
const MIN_BUILDING_PX = 16;
/** How far a straightened outline may stray from the traced one, in pixels. */
const SIMPLIFY_PX = 0.75;
/** The largest texture made, per side. */
const MAX_SIZE = 1024;

export interface Terrain {
  /** Pixels per side of the texture. */
  size: number;
  /** size × size RGBA texture: R street shade (0 open, 255 against a wall), G building, B inside the map. */
  pixels: Uint8Array;
  /**
   * Building walls, four numbers per segment: x0, y0, x1, y1. The outlines go round so that the outward normal of a
   * segment is (y0 - y1, x1 - x0).
   */
  walls: Float32Array;
  /** The outline of the whole map (streets and buildings), the same way. */
  edge: Float32Array;
}

/** The terrain in an RGBA image of size × size pixels (row by row from the top left, as canvas ImageData). */
export function terrainFromImage(rgba: ArrayLike<number>, size: number): Terrain {
  const n = size * size;
  const street = new Uint8Array(n);
  for (let i = 0; i < n; i++) street[i] = rgba[i * 4 + 3]! >= STREET_ALPHA ? 1 : 0;

  // Outside: the clear pixels connected to the image's border.
  const clear = new Uint8Array(n);
  for (let i = 0; i < n; i++) clear[i] = street[i] ? 0 : 1;
  const outside = new Uint8Array(n);
  const border: number[] = [];
  for (let i = 0; i < size; i++) border.push(i, (size - 1) * size + i, i * size, i * size + size - 1);
  fill(outside, size, border, clear);

  // Buildings: the clear pixels inside, without the specks.
  const building = new Uint8Array(n);
  for (let i = 0; i < n; i++) building[i] = !street[i] && !outside[i] ? 1 : 0;
  dropSmall(building, size, MIN_BUILDING_PX);

  const inside = new Uint8Array(n);
  const pixels = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    inside[i] = outside[i] ? 0 : 1;
    const shade = street[i] ? (rgba[i * 4 + 3]! - OPEN_ALPHA) / (WALL_ALPHA - OPEN_ALPHA) : 0;
    pixels[i * 4] = Math.round(255 * Math.min(1, Math.max(0, shade)));
    pixels[i * 4 + 1] = building[i] ? 255 : 0;
    pixels[i * 4 + 2] = inside[i] ? 255 : 0;
    pixels[i * 4 + 3] = 255;
  }
  return { size, pixels, walls: outline(building, size), edge: outline(inside, size) };
}

/** Sets `mark` on the `open` pixels reachable from `seeds` through open pixels (4-connected). */
function fill(mark: Uint8Array, size: number, seeds: number[], open: Uint8Array) {
  const queue = new Int32Array(size * size);
  let head = 0;
  let tail = 0;
  const reach = (j: number) => {
    if (open[j] && !mark[j]) {
      mark[j] = 1;
      queue[tail++] = j;
    }
  };
  for (const s of seeds) reach(s);
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % size;
    if (x > 0) reach(i - 1);
    if (x < size - 1) reach(i + 1);
    if (i >= size) reach(i - size);
    if (i < size * (size - 1)) reach(i + size);
  }
}

/** Clears the 4-connected groups of set pixels that have fewer than `min` pixels. */
function dropSmall(mask: Uint8Array, size: number, min: number) {
  const seen = new Uint8Array(mask.length);
  const group: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    group.length = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      group.push(i);
      const x = i % size;
      for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, i - size, i + size]) {
        if (j >= 0 && j < mask.length && mask[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (group.length < min) for (const i of group) mask[i] = 0;
  }
}

/**
 * The outline of the set pixels as straightened wall segments in map units (see {@link Terrain.walls}).
 *
 * Marching squares over cells whose corners are pixel centres; a cell's outline runs between the midpoints of its
 * sides, kept in doubled pixel coordinates so they are whole numbers. Diagonal pairs (saddles) are kept apart.
 */
export function outline(mask: Uint8Array, size: number): Float32Array {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < size && y < size ? mask[y * size + x]! : 0);
  const row = 2 * size + 3;
  const key = (x2: number, y2: number) => y2 * row + x2;
  // Each midpoint starts exactly one segment, so the segments link up into loops through their starts.
  const next = new Map<number, number>();
  for (let y = -1; y < size; y++) {
    for (let x = -1; x < size; x++) {
      const c = (at(x, y) << 3) | (at(x + 1, y) << 2) | (at(x + 1, y + 1) << 1) | at(x, y + 1);
      if (c === 0 || c === 15) continue;
      const t = key(2 * x + 2, 2 * y + 1);
      const r = key(2 * x + 3, 2 * y + 2);
      const b = key(2 * x + 2, 2 * y + 3);
      const l = key(2 * x + 1, 2 * y + 2);
      // Directions keep the set pixels on the left, walking on the image (y down).
      switch (c) {
        case 1: next.set(b, l); break;
        case 2: next.set(r, b); break;
        case 3: next.set(r, l); break;
        case 4: next.set(t, r); break;
        case 5: next.set(t, r); next.set(b, l); break;
        case 6: next.set(t, b); break;
        case 7: next.set(t, l); break;
        case 8: next.set(l, t); break;
        case 9: next.set(b, t); break;
        case 10: next.set(l, t); next.set(r, b); break;
        case 11: next.set(r, t); break;
        case 12: next.set(l, r); break;
        case 13: next.set(b, r); break;
        case 14: next.set(l, b); break;
      }
    }
  }

  const unit = MAP_SIZE / size / 2; // doubled pixel coordinates → map units
  const out: number[] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop: [number, number][] = [];
    let k: number | undefined = start;
    while (k !== undefined && !done.has(k)) {
      done.add(k);
      loop.push([k % row, Math.floor(k / row)]);
      k = next.get(k);
    }
    // A tiny loop would straighten into a line: keep it as traced.
    const straight = simplifyLoop(loop, 2 * SIMPLIFY_PX);
    const pts = straight.length >= 3 ? straight : loop;
    if (pts.length < 3) continue;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      out.push(p[0] * unit, p[1] * unit, q[0] * unit, q[1] * unit);
    }
  }
  return new Float32Array(out);
}

/** A closed loop with as few points as stay within `eps` of it (Douglas-Peucker on its two halves). */
function simplifyLoop(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 4) return pts;
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i]![0] - pts[0]![0]) ** 2 + (pts[i]![1] - pts[0]![1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplify(pts.slice(0, far + 1), eps);
  const b = simplify([...pts.slice(far), pts[0]!], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Douglas-Peucker on an open polyline (iterative, so long outlines don't overflow the stack). */
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const spans: [number, number][] = [[0, pts.length - 1]];
  while (spans.length) {
    const [i, j] = spans.pop()!;
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[j]!;
    const len = Math.hypot(bx - ax, by - ay);
    let worst = -1;
    let at = -1;
    for (let m = i + 1; m < j; m++) {
      const [px, py] = pts[m]!;
      const d = len > 0 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > worst) {
        worst = d;
        at = m;
      }
    }
    if (worst > eps) {
      keep[at] = 1;
      spans.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const terrains = new Map<string, Promise<Terrain>>();

/**
 * The terrain for a minimap image, traced once per image. The image must be served with CORS (deadlock-api's is) so
 * its pixels can be read; otherwise this fails and the 2.5D view shows the flat image instead.
 */
export function loadTerrain(url: string): Promise<Terrain> {
  let p = terrains.get(url);
  if (!p) {
    p = loadImage(url).then((img) => {
      const side = Math.max(img.naturalWidth, img.naturalHeight, 1);
      const size = Math.min(MAX_SIZE, 2 ** Math.ceil(Math.log2(side)));
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2D canvas');
      ctx.drawImage(img, 0, 0, size, size);
      return terrainFromImage(ctx.getImageData(0, 0, size, size).data, size);
    });
    p.catch(() => terrains.delete(url)); // try again next time
    terrains.set(url, p);
  }
  return p;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}
