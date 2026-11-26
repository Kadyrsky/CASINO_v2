import { describe, expect, it } from 'vite-plus/test';
import type { LiveFrame } from '../api/types';
import { placementMatrices, objectVertices } from './mapObjectRenderer';
import {
  GROWN_HEIGHT,
  decodeObjects,
  grownBy,
  heightOf,
  modelFor,
  nearestSpawn,
  objectiveKey,
  placements,
  powerupKey,
  type MapObjects,
} from './mapObjects';

interface ModelSpec {
  name: string;
  scale: number;
  vertices: [number, number, number][];
  triangles: [number, number, number][];
  /** Per skin: name, then each triangle's colour and glow. */
  skins: [string, [number, number, number, number][]][];
}
type SpawnSpec = [kind: string, team: number, x: number, y: number, z: number, yaw: number];

/** An objects file as scripts/map_objects.py writes it (unzipped). */
function file(models: ModelSpec[], spawns: SpawnSpec[]): ArrayBuffer {
  const bytes: number[] = [];
  const push = (n: number, write: (dv: DataView) => void) => {
    const b = new DataView(new ArrayBuffer(n));
    write(b);
    bytes.push(...new Uint8Array(b.buffer));
  };
  const u32 = (v: number) => push(4, (d) => d.setUint32(0, v, true));
  const f32 = (v: number) => push(4, (d) => d.setFloat32(0, v, true));
  const text = (s: string) => bytes.push(s.length, ...[...s].map((c) => c.charCodeAt(0)));
  bytes.push(0x4e, 0x4f, 0x42, 0x4a); // "NOBJ"
  u32(1);
  u32(models.length);
  for (const m of models) {
    text(m.name);
    f32(m.scale);
    u32(m.vertices.length);
    u32(m.triangles.length);
    const lo = [0, 1, 2].map((i) => Math.min(...m.vertices.map((v) => v[i]!)));
    const hi = [0, 1, 2].map((i) => Math.max(...m.vertices.map((v) => v[i]!)));
    lo.forEach(f32);
    hi.forEach(f32);
    u32(m.skins.length);
    for (const v of m.vertices) for (let i = 0; i < 3; i++) push(2, (d) => d.setUint16(0, Math.round(((v[i]! - lo[i]!) / (hi[i]! - lo[i]! || 1)) * 65535), true));
    for (const i of m.triangles.flat()) push(2, (d) => d.setUint16(0, i, true));
    for (const [name, rows] of m.skins) {
      text(name);
      bytes.push(...rows.flatMap((r) => r.slice(0, 3)));
      bytes.push(...rows.map((r) => r[3]));
    }
  }
  u32(spawns.length);
  for (const [kind, team, x, y, z, yaw] of spawns) {
    text(kind);
    bytes.push(team);
    [x, y, z, yaw].forEach(f32);
  }
  return new Uint8Array(bytes).buffer;
}

/**
 * A one-triangle model standing up from its feet: 0 to `top` model units high (corners that quantize exactly), at
 * `scale` world units per model unit.
 */
const triangle = (name: string, skins: string[], top = 200, scale = 0.5): ModelSpec => ({
  name,
  scale,
  vertices: [
    [-50, 0, 0],
    [50, 0, 0],
    [-50, 0, top],
  ],
  triangles: [[0, 1, 2]],
  skins: skins.map((s, i) => [s, [[200 + i, 100, 50, i * 255]]]),
});

const SPAWNS: SpawnSpec[] = [
  ['guardian', 0, -8192, -1856, 248, 90],
  ['guardian', 1, -7040, 1984, 248, 270],
  ['walker', 0, -1288, -3472, 376, 30],
  ['base_guardian', 1, 1064, 5454, 640, 315],
  ['shrine', 0, 299, -7535, 980, 175],
  ['shrine', 1, -256, 7536, 1000, 20],
  ['patron', 0, -1280, -8034, 632, 90],
  ['patron', 1, 1280, 8048, 632, 270],
  ['powerup', 255, -3936, 136, 912, 0],
  ['mystery', 0, 0, 0, 0, 0], // a kind this site doesn't know: left out
];

const objects = (): MapObjects =>
  decodeObjects(
    file(
      [
        triangle('guardian', ['0', '1']),
        triangle('walker', ['0', '1']),
        triangle('base_guardian_0', ['0']),
        triangle('base_guardian_1', ['0']),
        triangle('shrine_0', ['0'], 400, 1),
        triangle('shrine_1', ['0'], 400, 1),
        // As tall as the game's patrons (about 1,800 world units), past GROWN_HEIGHT already.
        triangle('patron_0', ['0'], 1800, 1),
        triangle('patron_1', ['0'], 2000, 0.8),
        triangle('powerup', ['0', 'gun', 'casting']),
      ],
      SPAWNS,
    ),
  );

describe('decodeObjects', () => {
  it('reads the models, their skins and the spawns', () => {
    const o = objects();
    expect([...o.models.keys()]).toEqual([
      'guardian',
      'walker',
      'base_guardian_0',
      'base_guardian_1',
      'shrine_0',
      'shrine_1',
      'patron_0',
      'patron_1',
      'powerup',
    ]);
    const g = o.models.get('guardian')!;
    expect(g.scale).toBe(0.5);
    expect(Array.from(g.positions)).toEqual([-50, 0, 0, 50, 0, 0, -50, 0, 200]);
    expect(Array.from(g.indices)).toEqual([0, 1, 2]);
    expect(g.height).toBe(100); // 200 model units at half size
    expect(Array.from(g.skins.get('1')!)).toEqual([201, 100, 50, 255]); // colour, then glow
    expect(o.models.get('patron_1')!.height).toBeCloseTo(1600, 3); // 2000 model units at 0.8
    expect(o.spawns).toHaveLength(9);
    expect(o.spawns[0]).toEqual({ kind: 'guardian', team: 0, x: -8192, y: -1856, z: 248, yaw: 90 });
    expect(o.spawns.filter((s) => s.kind === 'shrine').map((s) => s.team)).toEqual([0, 1]);
    expect(o.spawns.find((s) => s.kind === 'powerup')!.team).toBeNull();
  });

  it('refuses what is not an objects file', () => {
    const good = file([triangle('guardian', ['0'])], []);
    expect(() => decodeObjects(new ArrayBuffer(16))).toThrow();
    expect(() => decodeObjects(good.slice(0, good.byteLength - 1))).toThrow();
    const longer = new Uint8Array(good.byteLength + 1);
    longer.set(new Uint8Array(good));
    expect(() => decodeObjects(longer.buffer)).toThrow();
  });
});

describe('models and spawns', () => {
  it('gives each team its skin, and base guardians their team’s own model', () => {
    const o = objects();
    expect(modelFor(o, 'guardian', 1)!.colours).toBe(o.models.get('guardian')!.skins.get('1'));
    expect(modelFor(o, 'walker', 0)!.colours).toBe(o.models.get('walker')!.skins.get('0'));
    expect(modelFor(o, 'base_guardian', 1)!.model.name).toBe('base_guardian_1');
    expect(modelFor(o, 'base_guardian', 0)!.model.name).toBe('base_guardian_0');
    // One skin: every team gets it.
    expect(modelFor(o, 'powerup', null)!.colours).toBe(o.models.get('powerup')!.skins.get('0'));
  });

  it('gives each team its own shrine and patron (the Hidden King, the Archmother)', () => {
    const o = objects();
    for (const team of [0, 1] as const) {
      expect(modelFor(o, 'shrine', team)!.model.name).toBe(`shrine_${team}`);
      expect(modelFor(o, 'patron', team)!.model.name).toBe(`patron_${team}`);
      expect(modelFor(o, 'patron', team)!.colours).toBe(o.models.get(`patron_${team}`)!.skins.get('0'));
    }
  });

  it('finds the nearest spawn of a kind within reach', () => {
    const o = objects();
    expect(nearestSpawn(o, 'guardian', -8100, -1800)?.team).toBe(0);
    expect(nearestSpawn(o, 'guardian', -7000, 2000)?.yaw).toBe(270);
    expect(nearestSpawn(o, 'walker', -8100, -1800)).toBeNull(); // a guardian's spot, no walker near
    expect(nearestSpawn(o, 'powerup', -3936 + 700, 136)).toBeNull();
  });

  it("takes a frame's height, else (older bots) the spawn's", () => {
    const o = objects();
    expect(heightOf(o, 'guardian', -8192, -1856, 300)).toBe(300);
    expect(heightOf(o, 'guardian', -8192, -1856, null)).toBe(248);
    expect(heightOf(o, 'patron', -1290, -8030, undefined)).toBe(632);
    expect(heightOf(o, 'shrine', -256, 7536, null)).toBe(1000);
    expect(heightOf(o, 'powerup', -3930, 140, null)).toBe(912);
    expect(heightOf(o, 'midboss', 0, 0, null)).toBeNull();
    expect(heightOf(null, 'guardian', -8192, -1856, null)).toBeNull();
  });
});

describe('placements', () => {
  const frame = (objectives: LiveFrame['objectives'], powerups: LiveFrame['powerups']) => ({ objectives, powerups }) as unknown as LiveFrame;

  it('stands the guardians, walkers, base guardians and power-ups of a frame, facing as the map places them', () => {
    const o = objects();
    const list = placements(
      o,
      frame(
        [
          { id: 7, kind: 'guardian', team: 1, lane: 1, x: -7040, y: 1984, z: 250, hp: 1, max_hp: 1 },
          { id: 8, kind: 'base_guardian', team: 1, lane: 4, x: 1064, y: 5454, hp: 1, max_hp: 1 },
          { id: 10, kind: 'midboss', team: null, lane: null, x: 0, y: 0, z: -832, hp: 1, max_hp: 1 }, // no model
        ],
        [{ x: -3936, y: 136 }],
      ),
    );
    expect(list.map((p) => p.key)).toEqual([objectiveKey(7), objectiveKey(8), powerupKey(-3936, 136)]);
    expect(list[0]).toMatchObject({ kind: 'guardian', z: 250, yaw: 270 });
    expect(list[0]!.colours).toBe(o.models.get('guardian')!.skins.get('1'));
    expect(list[1]).toMatchObject({ kind: 'base_guardian', z: 640, yaw: 315 }); // no height in the frame: the spawn's
    expect(list[1]!.model.name).toBe('base_guardian_1');
    expect(list[2]).toMatchObject({ kind: 'powerup', z: 912, yaw: 0 });
  });

  it("stands each team's shrines and patron as its own model, where and as high as the frame says", () => {
    const o = objects();
    const list = placements(
      o,
      frame(
        [
          // As a live broadcast has them (Nov 2026): shrines without a lane, the Archmother's patron at lane 0.
          { id: 1841, kind: 'shrine', team: 1, lane: null, x: -256, y: 7536, z: 1000, hp: 5000, max_hp: 5000 },
          { id: 1758, kind: 'patron', team: 1, lane: 0, x: 1280, y: 8048, z: 632, hp: 15250, max_hp: 15250 },
          { id: 1690, kind: 'shrine', team: 0, lane: null, x: 299, y: -7535, hp: 2600, max_hp: 5000 }, // an older bot: no z
          { id: 1759, kind: 'patron', team: 0, lane: 0, x: -1280, y: -8034, z: 632, hp: 9000, max_hp: 14250 },
          // The core over a patron: no model of its own.
          { id: 2390, kind: 'patron_core', team: null, lane: null, x: -1280, y: -8034, z: 982, hp: 1, max_hp: 1 },
        ],
        [],
      ),
    );
    expect(list.map((p) => [p.key, p.model.name])).toEqual([
      [objectiveKey(1841), 'shrine_1'],
      [objectiveKey(1758), 'patron_1'],
      [objectiveKey(1690), 'shrine_0'],
      [objectiveKey(1759), 'patron_0'],
    ]);
    expect(list.map((p) => [p.kind, p.z, p.yaw])).toEqual([
      ['shrine', 1000, 20],
      ['patron', 632, 270],
      ['shrine', 980, 175], // the spawn's height
      ['patron', 632, 90],
    ]);
  });

  it('stands a shrine or patron only while the frames have it: destroyed, it is gone', () => {
    const o = objects();
    const shrines: LiveFrame['objectives'] = [
      { id: 1, kind: 'shrine', team: 0, lane: null, x: 299, y: -7535, z: 980, hp: 800, max_hp: 5000 },
      { id: 2, kind: 'shrine', team: 0, lane: null, x: -2859, y: -7535, z: 980, hp: 5000, max_hp: 5000 },
    ];
    const patron: LiveFrame['objectives'][number] = { id: 3, kind: 'patron', team: 0, lane: 0, x: -1280, y: -8034, z: 632, hp: 100, max_hp: 14250 };
    expect(placements(o, frame([...shrines, patron], [])).map((p) => p.key)).toEqual([objectiveKey(1), objectiveKey(2), objectiveKey(3)]);
    // The first shrine fell, then the patron: the bot leaves what has no health out of its frames.
    expect(placements(o, frame([shrines[1]!, patron], [])).map((p) => p.key)).toEqual([objectiveKey(2), objectiveKey(3)]);
    expect(placements(o, frame([shrines[1]!], [])).map((p) => p.key)).toEqual([objectiveKey(2)]);
  });

  it("colours a power-up's crystal for its kind, untinted when the kind isn't known", () => {
    const o = objects();
    const skins = o.models.get('powerup')!.skins;
    const list = placements(o, frame([], [{ x: -3936, y: 136, z: 912, kind: 'casting' }, { x: 3936, y: -128, z: 912, kind: 'survival' }, { x: 3936, y: -128, z: 912 }]));
    expect(list.map((p) => p.colours)).toEqual([skins.get('casting'), skins.get('0'), skins.get('0')]); // no survival skin: untinted
  });

  it('leaves out what has no height at all', () => {
    const o = objects();
    // Far from any walker's spawn, and no height in the frame.
    expect(placements(o, frame([{ id: 1, kind: 'walker', team: 0, lane: 1, x: 9000, y: 9000, hp: 1, max_hp: 1 }], []))).toEqual([]);
    expect(placements(o, undefined)).toEqual([]);
  });
});

describe('grownBy', () => {
  it('grows small models as asked, tall ones only up to GROWN_HEIGHT, and shrinks none for it', () => {
    const o = objects();
    const guardian = o.models.get('guardian')!; // 100 world units
    const shrine = o.models.get('shrine_0')!; // 400
    const patron = o.models.get('patron_0')!; // 1800: taller than GROWN_HEIGHT already
    expect(grownBy(guardian, 2.5)).toBe(2.5);
    expect(grownBy(shrine, 2.5)).toBe(2.5);
    expect(grownBy(shrine, 6)).toBeCloseTo(GROWN_HEIGHT / 400);
    expect(grownBy(patron, 2.5)).toBe(1);
    expect(grownBy(o.models.get('patron_1')!, 2.5)).toBe(1);
    // At their own size (zoomed in), all are as they are.
    for (const m of [guardian, shrine, patron]) expect(grownBy(m, 1)).toBe(1);
  });
});

describe('placementMatrices', () => {
  const apply = (m: Float32Array, v: [number, number, number]) =>
    [0, 1, 2].map((r) => m[r]! * v[0] + m[4 + r]! * v[1] + m[8 + r]! * v[2] + m[12 + r]!);
  const turn = (m: Float32Array, v: [number, number, number]) => [0, 1, 2].map((r) => m[r]! * v[0] + m[3 + r]! * v[1] + m[6 + r]! * v[2]);

  it('stands a model at its spot, facing its yaw, at the game’s scale in map units', () => {
    const model = objects().models.get('guardian')!;
    const k = (1000 / (2 * 10752)) * model.scale;
    // Facing north (yaw 90): the model's forward (+x) points up the map (-y on it); its left (+y) to the west.
    const m = placementMatrices({ model, colours: model.skins.get('0')!, x: 300, y: 400, h: 12, yaw: 90 }, 10752);
    const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 5));
    near(apply(m.model, [0, 0, 0]), [300, 400, 12]);
    near(apply(m.model, [100, 0, 0]), [300, 400 - 100 * k, 12]);
    near(apply(m.model, [0, 100, 0]), [300 - 100 * k, 400, 12]);
    near(apply(m.model, [0, 0, 100]), [300, 400, 12 + 100 * k]);
    // Normals turn the same way (and keep their length).
    near(turn(m.turn, [1, 0, 0]), [0, -1, 0]);
    near(turn(m.turn, [0, 0, 1]), [0, 0, 1]);
    // Grown about its feet.
    const big = placementMatrices({ model, colours: model.skins.get('0')!, x: 300, y: 400, h: 12, yaw: 0 }, 10752, 2);
    near(apply(big.model, [0, 0, 0]), [300, 400, 12]);
    near(apply(big.model, [0, 0, 100]), [300, 400, 12 + 200 * k]);
  });

  it('gives each triangle its outward normal and its colour and glow', () => {
    const model = objects().models.get('walker')!;
    const buf = objectVertices(model, model.skins.get('1')!);
    expect(buf.byteLength).toBe(3 * 20);
    const i8 = new Int8Array(buf);
    const u8 = new Uint8Array(buf);
    // The triangle stands in the x-z plane, wound so it faces -y (its right side, seen from the front).
    expect([i8[12], i8[13], i8[14]]).toEqual([0, -127, 0]);
    expect([u8[16], u8[17], u8[18], u8[19]]).toEqual([201, 100, 50, 255]);
  });
});
