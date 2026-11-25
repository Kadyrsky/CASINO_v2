/**
 * The map files the site ships (public/maps: the 3D view's models of the map, standard and High quality, and the models
 * standing on it), read and used the way the views use them, with real heroes' positions from live broadcasts
 * (e2e/fixtures/heroes.json) and the game's own objective positions (e2e/fixtures/objectives.json). They fail when a
 * rebuild of the files (scripts/map_model.py, scripts/map_objects.py) breaks what the views rely on.
 */
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vite-plus/test';
import { BAND, InteriorIndex, OPEN_RADIUS, SLICE, SLICE_STRIDE } from './mapInteriors';
import { decodeModel, groundHeight, inArena, mapHeight, type MapModel } from './mapModel';
import { decodeObjects, grownBy, heightOf, modelFor, nearestSpawn, type MapObjects } from './mapObjects';
import { POWERUP_LOOKS } from './powerupIcons';

const here = (path: string) => new URL(`../../${path}`, import.meta.url);

function unzip(path: string): ArrayBuffer {
  const b = gunzipSync(readFileSync(here(path)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

const MODELS = {
  standard: 'public/maps/dl_midtown.bin.gz',
  high: 'public/maps/dl_midtown.high.bin.gz',
} as const;
const model = (q: keyof typeof MODELS) => once(q, () => decodeModel(unzip(MODELS[q])));
const objects = () => once('objects', () => decodeObjects(unzip('public/maps/objects.bin.gz')));

type Xyz = [number, number, number];
const heroes = JSON.parse(readFileSync(here('e2e/fixtures/heroes.json'), 'utf8')) as Record<'hidden' | 'seen' | 'arena', Xyz[]>;
const objectives = JSON.parse(readFileSync(here('e2e/fixtures/objectives.json'), 'utf8')) as { kind: string; team: 0 | 1; x: number; y: number; z: number }[];

/** A world point (x, y as frames have them) on the map: 0–1000, y down, as the views place it. */
const onMap = (m: MapModel, x: number, y: number): [number, number] => [((x + m.radius) / (2 * m.radius)) * 1000, ((m.radius - y) / (2 * m.radius)) * 1000];

/** Where a hero at world point (x, y, z) stands in an interior, as the 3D view finds it, or null. */
function footing(m: MapModel, [x, y, z]: Xyz) {
  const [mx, my] = onMap(m, x, y);
  return InteriorIndex.of(m)!.footing(mx, my, mapHeight(m, z));
}

/** The model's surfaces facing up, on a grid: the floors the views can show. */
function floors(m: MapModel) {
  return once(`floors:${m.indices.length}`, () => {
    const P = m.positions;
    const I = m.indices;
    const CELL = 4;
    const n = 250;
    const grid = new Map<number, number[]>();
    for (let t = 0; t < I.length / 3; t++) {
      const [a, b, c] = [I[t * 3]! * 3, I[t * 3 + 1]! * 3, I[t * 3 + 2]! * 3];
      // Up in map space: y runs down the map, so a floor's corners wind clockwise seen from above.
      const nz = -((P[b]! - P[a]!) * (P[c + 1]! - P[a + 1]!) - (P[b + 1]! - P[a + 1]!) * (P[c]! - P[a]!));
      const len = Math.hypot(nz, 1e-9);
      if (nz <= 0 || len === 0) continue;
      const cell = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v / CELL)));
      for (let y = cell(Math.min(P[a + 1]!, P[b + 1]!, P[c + 1]!)); y <= cell(Math.max(P[a + 1]!, P[b + 1]!, P[c + 1]!)); y++) {
        for (let x = cell(Math.min(P[a]!, P[b]!, P[c]!)); x <= cell(Math.max(P[a]!, P[b]!, P[c]!)); x++) {
          const k = y * n + x;
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(t);
        }
      }
    }
    /** Heights (map units) of the model's floors at map point (x, y). */
    return (x: number, y: number): number[] => {
      const out: number[] = [];
      for (const t of grid.get(Math.floor(y / CELL) * n + Math.floor(x / CELL)) ?? []) {
        const [a, b, c] = [I[t * 3]! * 3, I[t * 3 + 1]! * 3, I[t * 3 + 2]! * 3];
        const den = (P[b + 1]! - P[c + 1]!) * (P[a]! - P[c]!) + (P[c]! - P[b]!) * (P[a + 1]! - P[c + 1]!);
        if (!den) continue;
        const wa = ((P[b + 1]! - P[c + 1]!) * (x - P[c]!) + (P[c]! - P[b]!) * (y - P[c + 1]!)) / den;
        const wb = ((P[c + 1]! - P[a + 1]!) * (x - P[c]!) + (P[a]! - P[c]!) * (y - P[c + 1]!)) / den;
        const wc = 1 - wa - wb;
        if (wa >= -1e-4 && wb >= -1e-4 && wc >= -1e-4) out.push(wa * P[a + 2]! + wb * P[b + 2]! + wc * P[c + 2]!);
      }
      return out;
    };
  });
}

const share = <T>(list: T[], test: (t: T) => boolean) => list.filter(test).length / list.length;

describe.each(['standard', 'high'] as const)('the %s model of the map', (quality) => {
  const m = () => model(quality);

  it('is the game map in the views’ space, small enough to send', { timeout: 30_000 }, () => {
    expect(m().radius).toBe(10752);
    const P = m().positions;
    for (let i = 0; i < P.length; i += 3) {
      expect(P[i]).toBeGreaterThanOrEqual(0);
      expect(P[i]).toBeLessThanOrEqual(1000);
      expect(P[i + 1]).toBeGreaterThanOrEqual(0);
      expect(P[i + 1]).toBeLessThanOrEqual(1000);
    }
    const triangles = m().indices.length / 3;
    // About 233,000 and 533,000 now: the High quality model has about twice the detail.
    if (quality === 'standard') expect(triangles).toBeGreaterThan(150_000);
    else expect(triangles).toBeGreaterThan(1.6 * (model('standard').indices.length / 3));
    // What the README promises: 1.9 and 4.1 MB to download.
    expect(statSync(here(MODELS[quality])).size).toBeLessThan(quality === 'standard' ? 2.5e6 : 5e6);
    expect(m().colors.length).toBe(triangles * 3);
    expect(new Set(Array.from({ length: 2000 }, (_, i) => m().colors[Math.floor((i * triangles) / 2000) * 3])).size).toBeGreaterThan(20);
  });

  it('has the ground grid markers without heights stand on, at street level', () => {
    const g = m().ground;
    expect(m().groundSize).toBe(512);
    expect(g.length).toBe(512 * 512);
    expect(g.every(Number.isFinite)).toBe(true);
    // The Mid-Boss's plaza, in the middle, is a street: about 100 world units down, not the hall 830 down.
    expect(groundHeight(m(), 500, 500)).toBeGreaterThan(mapHeight(m(), -300));
  });

  it('has the Mid-Boss hall in the middle of the map, under its plaza', () => {
    const a = m().arena!;
    expect(a.x0).toBeLessThan(500);
    expect(a.x1).toBeGreaterThan(500);
    expect(a.y0).toBeLessThan(500);
    expect(a.y1).toBeGreaterThan(500);
    expect(a.top).toBeCloseTo(mapHeight(m(), -250), 3);
    for (const p of heroes.arena) {
      const [x, y] = onMap(m(), p[0], p[1]);
      expect(inArena(a, x, y, mapHeight(m(), p[2]))).toBe(true);
    }
  });

  it("has the interiors' floors, each in an interior, over floors the model keeps", { timeout: 30_000 }, () => {
    const { positions: P, indices: I, regions } = m().interiors;
    const count = I.length / 3;
    expect(count).toBeGreaterThan(1000);
    expect(regions.length).toBe(count);
    // Interiors numbered from 0, each with some floor.
    const used = new Set(regions);
    expect(used.size).toBeGreaterThan(50);
    expect(Math.max(...used)).toBe(used.size - 1);
    // Every interior's floor is drawn: under nearly every one of its triangles, the model has a floor within 60 world
    // units (it was kept although no camera sees it). Hole fillers over pillars are the exceptions.
    const at = floors(m());
    const near = mapHeight(m(), 60);
    let kept = 0;
    for (let t = 0; t < count; t++) {
      const [a, b, c] = [I[t * 3]! * 3, I[t * 3 + 1]! * 3, I[t * 3 + 2]! * 3];
      const x = (P[a]! + P[b]! + P[c]!) / 3;
      const y = (P[a + 1]! + P[b + 1]! + P[c + 1]!) / 3;
      const h = (P[a + 2]! + P[b + 2]! + P[c + 2]!) / 3;
      if (at(x, y).some((f) => Math.abs(f - h) < near)) kept++;
    }
    expect(kept / count).toBeGreaterThan(0.8);
  });
});

describe('heroes where no camera sees them (real positions from live broadcasts)', () => {
  const m = () => model('standard');

  it('in the Mid-Boss hall, stand in one interior, the hall, its sunken corner included', () => {
    const found = heroes.arena.map((p) => footing(m(), p)).filter((f) => f != null);
    // Measured: 118 of 120 (the other two jump or stand in a pit's wall).
    expect(found.length / heroes.arena.length).toBeGreaterThan(0.95);
    expect(new Set(found.map((f) => f.region)).size).toBe(1);
    // Its floor, about 830 world units down.
    for (const f of found) expect(f.floor).toBeLessThan(mapHeight(m(), -700));
  });

  it('on floors no camera sees, most stand in an interior; on floors cameras see, hardly any do', () => {
    // Measured: 87% and 3%. Small nooks (under arches, awnings) are left covered on purpose; doorways count as inside.
    expect(share(heroes.hidden, (p) => footing(m(), p) != null)).toBeGreaterThan(0.8);
    expect(share(heroes.seen, (p) => footing(m(), p) != null)).toBeLessThan(0.05);
  });

  it('open their interior around them: a slice over its floor, out to the opening radius', { timeout: 30_000 }, () => {
    const index = InteriorIndex.of(m())!;
    const radius = mapHeight(m(), OPEN_RADIUS);
    const lift = mapHeight(m(), SLICE);
    const band = mapHeight(m(), BAND);
    for (const p of [...heroes.arena, ...heroes.hidden].slice(0, 300)) {
      const f = footing(m(), p);
      if (!f) continue;
      const [x, y] = onMap(m(), p[0], p[1]);
      const data = index.slices([{ x, y, ...f }]);
      expect(data.length).toBeGreaterThan(0);
      expect(data.length % (3 * SLICE_STRIDE)).toBe(0);
      // Each triangle: cut to the hero's own circle (floats, as the GPU gets them); its floor raised by the slice,
      // reaching into the band round the hero's own floor (ramps, not the storey above or below).
      const circle = [Math.fround(x), Math.fround(y), Math.fround(radius)];
      const wrong: number[] = [];
      for (let i = 0; i < data.length; i += 3 * SLICE_STRIDE) {
        const corners = [0, 1, 2].map((k) => i + k * SLICE_STRIDE);
        const heights = corners.map((c) => data[c + 2]! - lift);
        const ownCircle = corners.every((c) => circle.every((v, k) => data[c + 3 + k] === v));
        if (!ownCircle || Math.max(...heights) < f.floor - band - 1e-3 || Math.min(...heights) > f.floor + band + 1e-3) wrong.push(i);
      }
      expect(wrong, `${p}`).toEqual([]);
    }
  });

  it('are found about the same way in the High quality model', () => {
    const standard = heroes.arena.map((p) => footing(model('standard'), p) != null);
    const high = heroes.arena.map((p) => footing(model('high'), p) != null);
    expect(share(high, (h) => h)).toBeGreaterThan(0.95);
    expect(share(standard.map((s, i) => s === high[i]), (same) => same)).toBeGreaterThan(0.95);
    expect(share(heroes.hidden, (p) => footing(model('high'), p) != null)).toBeGreaterThan(0.8);
    expect(share(heroes.seen, (p) => footing(model('high'), p) != null)).toBeLessThan(0.05);
  });
});

describe('the models standing on the map', () => {
  const o = (): MapObjects => objects();

  it('has the guardians, walkers, both base guardians and the power-up crystal, in every skin the view asks for', () => {
    for (const name of ['guardian', 'walker', 'base_guardian_0', 'base_guardian_1', 'powerup']) {
      const model = o().models.get(name)!;
      expect(model, name).toBeDefined();
      expect(model.indices.length / 3).toBeGreaterThan(100);
      expect(model.height).toBeGreaterThan(0);
    }
    for (const team of [0, 1] as const) {
      expect(modelFor(o(), 'guardian', team)!.colours).toBe(o().models.get('guardian')!.skins.get(String(team)));
      expect(modelFor(o(), 'base_guardian', team)!.model.name).toBe(`base_guardian_${team}`);
    }
    // The crystal in each power-up kind's colour, and untinted.
    const skins = o().models.get('powerup')!.skins;
    for (const kind of [...Object.keys(POWERUP_LOOKS), '0']) expect(skins.has(kind), kind).toBe(true);
  });

  it("has each team's shrine and patron, the Hidden King and the Archmother, at the game's size", () => {
    for (const team of [0, 1] as const) {
      const shrine = modelFor(o(), 'shrine', team)!;
      const patron = modelFor(o(), 'patron', team)!;
      expect(shrine.model.name).toBe(`shrine_${team}`);
      expect(patron.model.name).toBe(`patron_${team}`);
      for (const { model, colours } of [shrine, patron]) {
        expect(model.indices.length / 3, model.name).toBeGreaterThan(1000);
        expect(colours, model.name).toBe(model.skins.get('0')); // the team's own model: one skin
      }
      // Shrines on their pedestals at three quarters of their model's size, 350 to 450 world units high without the
      // light the Archmother's book shines; the patrons tower over the base, about 1,800 (her model at 0.8).
      expect(shrine.model.scale).toBeCloseTo(0.75, 5);
      expect(shrine.model.height).toBeGreaterThan(350);
      expect(shrine.model.height).toBeLessThan(450);
      expect(patron.model.height).toBeGreaterThan(1500);
      expect(patron.model.height).toBeLessThan(2100);
      // Drawn bigger than they are with the whole map in view, the shrines grow as the guardians do; the patrons don't.
      expect(grownBy(shrine.model, 2.5)).toBe(2.5);
      expect(grownBy(patron.model, 2.5)).toBe(1);
    }
    expect(modelFor(o(), 'patron', 1)!.model.scale).toBeCloseTo(0.8, 5);
  });

  it("places every objective where the game does, so frames without heights stand them right", () => {
    const counts = new Map<string, number>();
    for (const s of o().spawns) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ guardian: 6, walker: 6, base_guardian: 12, shrine: 4, patron: 2, powerup: 2 });
    for (const ob of objectives.filter((ob) => ob.kind !== 'midboss')) {
      const spawn = nearestSpawn(o(), ob.kind as 'guardian', ob.x, ob.y);
      expect(spawn, `${ob.kind} at ${ob.x}, ${ob.y}`).not.toBeNull();
      expect(heightOf(o(), ob.kind, ob.x, ob.y, null)).toBeCloseTo(ob.z, -1);
      if (spawn!.team != null && ob.team != null) expect(spawn!.team).toBe(ob.team);
    }
  });
});
