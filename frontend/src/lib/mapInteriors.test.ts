import { describe, expect, it } from 'vite-plus/test';
import { InteriorIndex, OPEN_RADIUS, SLICE, SLICE_STRIDE, sameOpenings, type Opening } from './mapInteriors';
import { mapHeight, type MapModel } from './mapModel';

type Floor = [x0: number, y0: number, x1: number, y1: number, height: number, interior: number];

/** A model of interiors only: squares of floor in map units, each in an interior (two triangles each). */
function model(floors: Floor[]): MapModel {
  const positions: number[] = [];
  const indices: number[] = [];
  const regions: number[] = [];
  for (const [x0, y0, x1, y1, h, region] of floors) {
    const k = positions.length / 3;
    positions.push(x0, y0, h, x1, y0, h, x1, y1, h, x0, y1, h);
    indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
    regions.push(region, region);
  }
  return {
    radius: 10000, // the map's 1000 units are 20,000 world units: a world unit is 0.05 map units
    positions: new Float32Array(),
    indices: new Uint32Array(),
    colors: new Uint8Array(),
    ground: new Float32Array(),
    groundSize: 0,
    arena: null,
    interiors: { positions: new Float32Array(positions), indices: new Uint32Array(indices), regions: new Uint16Array(regions) },
  };
}

const TUNNEL: Floor = [480, 480, 520, 520, -20, 0]; // 400 world units under the street
const STOREY: Floor = [480, 480, 520, 520, 0, 1]; // another interior over it
const RAMP_TOP: Floor = [530, 480, 560, 520, 0, 0]; // the tunnel's, 400 units higher
const FAR_TUNNEL: Floor = [700, 480, 740, 520, -20, 2]; // 4,000 world units away
const map = () => model([TUNNEL, STOREY, RAMP_TOP, FAR_TUNNEL]);

/** Each slice vertex: its point and height, and its opening's point and radius. */
const vertices = (data: Float32Array) =>
  Array.from({ length: data.length / SLICE_STRIDE }, (_, i) => Array.from(data.slice(i * SLICE_STRIDE, (i + 1) * SLICE_STRIDE)));

describe('InteriorIndex', () => {
  it('is made once per model, and not for models without interiors', () => {
    const m = map();
    expect(InteriorIndex.of(m)).toBe(InteriorIndex.of(m));
    expect(InteriorIndex.of(model([]))).toBeNull();
  });

  it("finds the floor a hero stands on: under its feet or a hop below, the highest there, and the floor's interior", () => {
    const index = InteriorIndex.of(map())!;
    expect(index.footing(500, 500, -20)).toEqual({ floor: -20, region: 0 });
    expect(index.footing(500, 500, -15)).toEqual({ floor: -20, region: 0 }); // 100 world units up: a hop
    expect(index.footing(500, 500, -10)).toBeNull(); // 200 up: on something else, not in the tunnel
    expect(index.footing(500, 500, 0)).toEqual({ floor: 0, region: 1 }); // the storey above
    expect(index.footing(500, 500, 1)).toEqual({ floor: 0, region: 1 }); // a floor a little rougher than the hero
    expect(index.footing(600, 500, -20)).toBeNull(); // no interior there
  });

  it("opens the hero's own interior near its floor and around it, raised to the slice, cut to its circle", () => {
    const m = map();
    const index = InteriorIndex.of(m)!;
    const slice = mapHeight(m, SLICE);
    const radius = mapHeight(m, OPEN_RADIUS);
    // In the tunnel: the tunnel's floor, not the storey over it (another interior), nor its ramp's top (400 world
    // units up), nor the tunnel far off.
    const tunnel = vertices(index.slices([{ x: 500, y: 500, floor: -20, region: 0 }]));
    expect(tunnel).toHaveLength(6);
    for (const v of tunnel) {
      expect(v[0]).toBeGreaterThanOrEqual(480);
      expect(v[0]).toBeLessThanOrEqual(520);
      expect(v[2]).toBeCloseTo(-20 + slice, 5);
      expect(v.slice(3)).toEqual([500, 500, expect.closeTo(radius, 5)]);
    }
    // On the ramp's top: that floor alone.
    expect(vertices(index.slices([{ x: 545, y: 500, floor: 0, region: 0 }])).every((v) => v[0]! >= 530)).toBe(true);
    // Two heroes, two interiors: both, each with its own circle.
    const both = vertices(index.slices([{ x: 500, y: 500, floor: -20, region: 0 }, { x: 720, y: 500, floor: -20, region: 2 }]));
    expect(both).toHaveLength(12);
    expect(both.filter((v) => v[3] === 720)).toHaveLength(6);
    // Nothing of its interior within reach.
    expect(index.slices([{ x: 900, y: 900, floor: -20, region: 0 }])).toHaveLength(0);
  });
});

describe('sameOpenings', () => {
  const a: Opening[] = [{ x: 500, y: 500, floor: -20, region: 0 }];
  it('takes openings that moved a fraction of a map unit as the same, else not', () => {
    expect(sameOpenings(a, [{ x: 500.3, y: 499.8, floor: -20.1, region: 0 }])).toBe(true);
    expect(sameOpenings(a, [{ x: 501, y: 500, floor: -20, region: 0 }])).toBe(false);
    expect(sameOpenings(a, [{ x: 500, y: 500, floor: -20, region: 1 }])).toBe(false);
    expect(sameOpenings(a, [])).toBe(false);
    expect(sameOpenings([], [])).toBe(true);
  });
});
