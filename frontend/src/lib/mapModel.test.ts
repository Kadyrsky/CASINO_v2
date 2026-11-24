import { describe, expect, it } from 'vite-plus/test';
import { decodeModel, groundHeight, inArena, mapHeight, standHeight } from './mapModel';
import { SUN, modelVertices, sliceBox, sunMatrix } from './mapModelRenderer';

/** Interiors as a version 3 file gives them: floor corners (world units), triangles, each triangle's interior. */
interface InteriorSpec {
  corners: [number, number, number][];
  triangles: [number, number, number][];
  regions: number[];
}

/**
 * A model file as scripts/map_model.py writes it (unzipped): vertices in world units, rows of ground from the north;
 * version 2 when it has an arena box (world units: x0, y0, x1, y1, covered above), version 3 with interiors.
 */
function file(opts: {
  radius: number;
  zMin: number;
  zMax: number;
  vertices: [number, number, number][];
  triangles: [number, number, number][];
  colors: [number, number, number][];
  ground: number[][];
  arena?: [number, number, number, number, number];
  interiors?: InteriorSpec;
}) {
  const { radius: r, zMin, zMax, interiors } = opts;
  const q = (v: number, a: number, b: number) => Math.round(((v - a) / (b - a)) * 65535);
  const gs = opts.ground.length;
  const nv = opts.vertices.length;
  const nt = opts.triangles.length;
  const version = interiors ? 3 : opts.arena ? 2 : 1;
  const extra = interiors ? 28 + interiors.corners.length * 6 + interiors.triangles.length * 14 : opts.arena ? 20 : 0;
  const buf = new ArrayBuffer(32 + nv * 6 + nt * 12 + nt * 3 + gs * gs * 2 + extra);
  const dv = new DataView(buf);
  [0x4e, 0x4d, 0x41, 0x50].forEach((b, i) => dv.setUint8(i, b)); // "NMAP"
  dv.setUint32(4, version, true);
  dv.setFloat32(8, r, true);
  dv.setFloat32(12, zMin, true);
  dv.setFloat32(16, zMax, true);
  dv.setUint32(20, nv, true);
  dv.setUint32(24, nt, true);
  dv.setUint32(28, gs, true);
  let p = 32;
  for (const [x, y, z] of opts.vertices) {
    dv.setUint16(p, q(x, -r, r), true);
    dv.setUint16(p + 2, q(y, -r, r), true);
    dv.setUint16(p + 4, q(z, zMin, zMax), true);
    p += 6;
  }
  for (const i of opts.triangles.flat()) {
    dv.setUint32(p, i, true);
    p += 4;
  }
  for (const b of opts.colors.flat()) {
    dv.setUint8(p, b);
    p += 1;
  }
  for (const z of opts.ground.flat()) {
    dv.setUint16(p, q(z, zMin, zMax), true);
    p += 2;
  }
  for (const v of opts.arena ?? (interiors ? [0, 0, 0, 0, 0] : [])) {
    dv.setFloat32(p, v, true);
    p += 4;
  }
  if (interiors) {
    dv.setUint32(p, interiors.corners.length, true);
    dv.setUint32(p + 4, interiors.triangles.length, true);
    p += 8;
    for (const [x, y, z] of interiors.corners) {
      dv.setUint16(p, q(x, -r, r), true);
      dv.setUint16(p + 2, q(y, -r, r), true);
      dv.setUint16(p + 4, q(z, zMin, zMax), true);
      p += 6;
    }
    for (const i of interiors.triangles.flat()) {
      dv.setUint32(p, i, true);
      p += 4;
    }
    for (const region of interiors.regions) {
      dv.setUint16(p, region, true);
      p += 2;
    }
  }
  return buf;
}

const sample = (arena?: [number, number, number, number, number]) =>
  file({
    arena,
    radius: 1000,
    zMin: 0,
    zMax: 1000,
    // A floor triangle, wound anticlockwise seen from above (its normal points up), and one leaning wall.
    vertices: [[-1000, 1000, 0], [1000, 1000, 0], [-1000, -1000, 0], [0, 0, 1000]],
    triangles: [[0, 2, 1], [0, 1, 3]],
    colors: [[10, 20, 30], [200, 100, 50]],
    ground: [[0, 1000], [0, 1000]],
  });

/** The sample, version 3: one interior triangle (the map's west half, 200 world units down) in interior 7. */
const withInteriors = (interiors?: InteriorSpec) =>
  file({
    radius: 1000,
    zMin: -1000,
    zMax: 1000,
    vertices: [[-1000, 1000, 0], [1000, 1000, 0], [-1000, -1000, 0], [0, 0, 1000]],
    triangles: [[0, 2, 1], [0, 1, 3]],
    colors: [[10, 20, 30], [200, 100, 50]],
    ground: [[0, 1000], [0, 1000]],
    interiors: interiors ?? { corners: [[-1000, 1000, -200], [-1000, -1000, -200], [0, 0, -200]], triangles: [[0, 1, 2]], regions: [7] },
  });

describe('decodeModel', () => {
  it('reads the file into map space: y down, heights in map units', () => {
    const m = decodeModel(sample());
    expect(m.radius).toBe(1000);
    expect(Array.from(m.positions.slice(0, 3))).toEqual([0, 0, 0]); // north-west corner
    expect(m.positions[3]).toBeCloseTo(1000, 6); // north-east
    expect(m.positions[7]).toBeCloseTo(1000, 6); // south-west: y down
    expect(m.positions[9]).toBeCloseTo(500, 1); // the middle...
    expect(m.positions[11]).toBeCloseTo(500, 1); // ...1000 world units up, half the 2000-unit square
    expect(Array.from(m.indices)).toEqual([0, 2, 1, 0, 1, 3]);
    expect(Array.from(m.colors)).toEqual([10, 20, 30, 200, 100, 50]);
    expect(m.groundSize).toBe(2);
  });

  it('refuses other files, versions and lengths', () => {
    expect(() => decodeModel(new ArrayBuffer(40))).toThrow(/not a map model/);
    const wrongVersion = sample();
    new DataView(wrongVersion).setUint32(4, 4, true);
    expect(() => decodeModel(wrongVersion)).toThrow(/version 4/);
    expect(() => decodeModel(sample().slice(0, -2))).toThrow(/length/);
    expect(() => decodeModel(sample([-100, -100, 100, 100, -50]).slice(0, -4))).toThrow(/length/);
    expect(() => decodeModel(withInteriors().slice(0, -2))).toThrow(/length/);
    const badIndex = withInteriors({ corners: [[0, 0, 0]], triangles: [[0, 0, 1]], regions: [0] });
    expect(() => decodeModel(badIndex)).toThrow(/out of range/);
  });

  it("reads version 3's interiors into map space, each triangle with its interior, and none from older files", () => {
    expect(decodeModel(sample()).interiors.indices.length).toBe(0);
    expect(decodeModel(sample([-100, -300, 100, -100, -50])).interiors.regions.length).toBe(0);
    const m = decodeModel(withInteriors());
    expect(m.arena).toBeNull(); // a version 3 file without an arena
    // The corner at world (-1000, 1000, -200) is the map's north-west corner, 100 map units down.
    expect(Array.from(m.interiors.positions.slice(0, 3))).toEqual([0, 0, -100]);
    expect(m.interiors.positions[4]).toBeCloseTo(1000, 6); // y down: the south-west corner
    expect(Array.from(m.interiors.indices)).toEqual([0, 1, 2]);
    expect(Array.from(m.interiors.regions)).toEqual([7]);
  });

  it("reads version 2's arena box into map space, and none from version 1", () => {
    expect(decodeModel(sample()).arena).toBeNull();
    // 200 world units across the middle of a 2000-unit square, covered above -50 (map: 1000 across, heights halved).
    const a = decodeModel(sample([-100, -300, 100, -100, -50])).arena!;
    expect([a.x0, a.x1]).toEqual([450, 550]);
    expect([a.y0, a.y1]).toEqual([550, 650]); // south of the middle: lower on the map
    expect(a.top).toBe(-25);
    expect(inArena(a, 500, 600, -100)).toBe(true);
    expect(inArena(a, 500, 600, 0)).toBe(false); // on what covers it
    expect(inArena(a, 500, 400, -100)).toBe(false);
    expect(inArena(null, 500, 600, -100)).toBe(false);
    expect(decodeModel(sample([0, 0, 0, 0, 0])).arena).toBeNull(); // a map without one
  });
});

describe('groundHeight', () => {
  it('interpolates between cells and holds at the edges', () => {
    const m = decodeModel(sample()); // west column 0, east column 500 map units
    expect(groundHeight(m, 0, 500)).toBeCloseTo(0, 3);
    expect(groundHeight(m, 1000, 500)).toBeCloseTo(500, 1);
    expect(groundHeight(m, 500, 100)).toBeCloseTo(250, 1);
    expect(groundHeight(m, -50, 2000)).toBeCloseTo(0, 3);
  });
});

describe('mapHeight and standHeight', () => {
  it('scale world heights like the model: 1000 map units across the 2 × radius square', () => {
    expect(mapHeight({ radius: 10752 }, 912)).toBeCloseTo(42.41, 2); // a bridge power-up, 912 world units up
    expect(mapHeight({ radius: 10752 }, -832)).toBeCloseTo(-38.69, 2); // the Mid-Boss's pit
    expect(mapHeight({ radius: 1000 }, 0)).toBe(0);
  });

  it("puts a hero at its own height, matching the model's own vertices", () => {
    const m = decodeModel(sample()); // the wall's top corner is 1000 world units up: 500 map units
    expect(standHeight(m, 500, 500, 1000)).toBeCloseTo(m.positions[11]!, 1);
    expect(standHeight(m, 0, 500, -200)).toBeCloseTo(-100, 6); // below the ground grid: a tunnel
  });

  it('falls back to the ground grid without a height (frames from older bots)', () => {
    const m = decodeModel(sample());
    expect(standHeight(m, 1000, 500, null)).toBeCloseTo(groundHeight(m, 1000, 500), 6);
    expect(standHeight(m, 500, 100, undefined)).toBeCloseTo(250, 1);
    expect(standHeight(m, 500, 100, Number.NaN)).toBeCloseTo(250, 1);
  });
});

describe('sunMatrix', () => {
  /** A map point (x, y, height) in the shadow map's clip space. */
  const apply = (m: Float32Array, p: number[]) => [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!);

  it('holds the whole map, from its lowest to its highest point, and nothing much more', () => {
    const m = sunMatrix(-30, 240);
    const seen = [[1, -1], [1, -1], [1, -1]];
    for (const x of [0, 1000]) {
      for (const y of [0, 1000]) {
        for (const h of [-30, 240]) {
          apply(m, [x, y, h]).forEach((v, i) => {
            expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
            seen[i] = [Math.min(seen[i]![0]!, v), Math.max(seen[i]![1]!, v)];
          });
        }
      }
    }
    for (const [lo, hi] of seen) expect([lo, hi]).toEqual([expect.closeTo(-1, 5), expect.closeTo(1, 5)]);
  });

  it('looks along the sunlight: further down a ray is the same spot of the shadow map, only deeper', () => {
    const m = sunMatrix(-30, 240);
    const p = [500, 500, 100];
    const a = apply(m, p);
    const b = apply(m, p.map((v, i) => v - SUN[i]! * 50));
    expect(b[0]).toBeCloseTo(a[0]!, 6);
    expect(b[1]).toBeCloseTo(a[1]!, 6);
    expect(b[2]!).toBeGreaterThan(a[2]!);
  });
});

describe('sliceBox', () => {
  it("bounds the slices' corners on the canvas, in pixels from the bottom left", () => {
    // Through the identity, x and y are already clip space: -1 to 1 across the canvas.
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const slices = new Float32Array([-1, -1, 0, 9, 9, 9, 0.5, 0, 0, 9, 9, 9, -0.5, 0.5, 0, 9, 9, 9]);
    expect(sliceBox(slices, identity, 200, 100)).toEqual([0, 0, 150, 75]);
    // A corner behind the camera (w <= 0) could project anywhere: the whole canvas.
    const behind = new Float32Array(identity);
    behind[15] = -1;
    expect(sliceBox(slices, behind, 200, 100)).toEqual([0, 0, 200, 100]);
  });
});

describe('modelVertices', () => {
  it('gives each corner its triangle normal (up for a floor, despite the y flip) and colour', () => {
    const m = decodeModel(sample());
    const buf = modelVertices(m);
    expect(buf.byteLength).toBe(2 * 3 * 20);
    const i8 = new Int8Array(buf);
    const u8 = new Uint8Array(buf);
    for (let k = 0; k < 3; k++) {
      const o = k * 20;
      expect([i8[o + 12], i8[o + 13], i8[o + 14]]).toEqual([0, 0, 127]);
      expect([u8[o + 16], u8[o + 17], u8[o + 18]]).toEqual([10, 20, 30]);
    }
    expect(new Float32Array(buf)[5 * 5 + 2]).toBeCloseTo(500, 1); // the wall's top corner keeps its height
  });
});
