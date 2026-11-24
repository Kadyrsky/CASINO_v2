import { describe, expect, it } from 'vite-plus/test';
import { outline, terrainFromImage } from './mapTerrain';

/** A size × size mask with the pixels where `set(x, y)` holds. */
function mask(size: number, set: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y * size + x] = set(x, y) ? 1 : 0;
  return m;
}

function segments(flat: Float32Array): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < flat.length; i += 4) out.push([flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!]);
  return out;
}

/** Whether the mask is set at a map point (map units → pixels). */
function setAt(m: Uint8Array, size: number, x: number, y: number): boolean {
  const px = Math.floor((x / 1000) * size);
  const py = Math.floor((y / 1000) * size);
  return px >= 0 && py >= 0 && px < size && py < size && m[py * size + px] === 1;
}

/** Each segment's normal (y0 - y1, x1 - x0) points out of the set pixels, and every loop closes. */
function expectOutwardLoops(flat: Float32Array, m: Uint8Array, size: number) {
  const segs = segments(flat);
  expect(segs.length).toBeGreaterThan(0);
  const starts = new Set(segs.map(([x0, y0]) => `${x0},${y0}`));
  const step = (0.6 * 1000) / size;
  for (const [x0, y0, x1, y1] of segs) {
    expect(starts.has(`${x1},${y1}`)).toBe(true);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const [nx, ny] = [(y0 - y1) / len, (x1 - x0) / len];
    const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
    expect(setAt(m, size, mx + nx * step, my + ny * step)).toBe(false);
    expect(setAt(m, size, mx - nx * step, my - ny * step)).toBe(true);
  }
}

describe('outline', () => {
  it('traces a block into a closed loop around its pixels, facing out', () => {
    const size = 8;
    const m = mask(size, (x, y) => x >= 2 && x <= 5 && y >= 2 && y <= 5);
    const flat = outline(m, size);
    expectOutwardLoops(flat, m, size);
    const xs = segments(flat).flatMap(([x0, , x1]) => [x0, x1]);
    const ys = segments(flat).flatMap(([, y0, , y1]) => [y0, y1]);
    // The pixels span 2–6 of 8, so 250–750 map units (the corners are cut by half a pixel at most).
    expect(Math.min(...xs)).toBeCloseTo(250, 6);
    expect(Math.max(...xs)).toBeCloseTo(750, 6);
    expect(Math.min(...ys)).toBeCloseTo(250, 6);
    expect(Math.max(...ys)).toBeCloseTo(750, 6);
    // Straight sides become single segments.
    expect(segments(flat).length).toBeLessThanOrEqual(8);
  });

  it('traces holes the other way round, so their walls face into the hole', () => {
    const size = 12;
    const m = mask(size, (x, y) => x >= 1 && x <= 10 && y >= 1 && y <= 10 && !(x >= 4 && x <= 7 && y >= 4 && y <= 7));
    expectOutwardLoops(outline(m, size), m, size);
  });

  it('keeps diagonal neighbours apart, and straightens a staircase', () => {
    const size = 24;
    const stairs = mask(size, (x, y) => x >= 2 && y >= 2 && y <= 21 && x <= 23 - y);
    const flat = outline(stairs, size);
    expectOutwardLoops(flat, stairs, size);
    // A one-pixel staircase becomes a diagonal wall, not a zigzag of tiny walls.
    expect(segments(flat).length).toBeLessThan(10);

    const diagonal = mask(size, (x, y) => (x === 5 && y === 5) || (x === 6 && y === 6));
    expect(segments(outline(diagonal, size)).length).toBeGreaterThanOrEqual(6); // two separate loops
  });
});

describe('terrainFromImage', () => {
  /** A 32 px image: clear border, street ring, a 5×5 clear hole (a building) and a 2-pixel speck. */
  function image() {
    const size = 32;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const street = x >= 2 && x <= 29 && y >= 2 && y <= 29;
        const hole = x >= 12 && x <= 16 && y >= 12 && y <= 16;
        const speck = y === 5 && (x === 5 || x === 6);
        rgba[(y * size + x) * 4 + 3] = street && !hole && !speck ? (x === 11 ? 223 : 178) : 0;
      }
    }
    return { rgba, size };
  }

  it('tells streets, buildings and the outside apart', () => {
    const { rgba, size } = image();
    const t = terrainFromImage(rgba, size);
    const px = (x: number, y: number) => Array.from(t.pixels.slice((y * size + x) * 4, (y * size + x) * 4 + 4));
    expect(px(0, 0)).toEqual([0, 0, 0, 255]); // outside
    expect(px(20, 20)).toEqual([0, 0, 255, 255]); // open street
    expect(px(11, 14)).toEqual([255, 0, 255, 255]); // street against the wall
    expect(px(14, 14)).toEqual([0, 255, 255, 255]); // building
    expect(px(5, 5)).toEqual([0, 0, 255, 255]); // a speck is street, not a building
  });

  it('outlines the buildings and the whole map', () => {
    const { rgba, size } = image();
    const t = terrainFromImage(rgba, size);
    const building = mask(size, (x, y) => x >= 12 && x <= 16 && y >= 12 && y <= 16);
    const inside = mask(size, (x, y) => x >= 2 && x <= 29 && y >= 2 && y <= 29);
    expectOutwardLoops(t.walls, building, size);
    expectOutwardLoops(t.edge, inside, size);
  });
});
