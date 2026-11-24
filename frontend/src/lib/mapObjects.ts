/**
 * The models the 3D view stands on the map: the lane guardians, the walkers, the base guardians (a different statue
 * for each team) and the bridge power-ups, from the game's own models, made by scripts/map_objects.py (see its
 * docstring for how and for the file format), served from /maps/objects.bin.gz. With them, where the map places each
 * one and which way it faces, so frames without heights (older bots) still stand them right.
 */
import type { LiveFrame, ObjectiveKind } from '../api/types';

export const OBJECTS_URL = '/maps/objects.bin.gz';

/** What a model stands for: an objective kind the bot reports, or a bridge power-up. */
export type ObjectKind = Extract<ObjectiveKind, 'guardian' | 'walker' | 'base_guardian'> | 'powerup';
/** What the map places: the models' kinds, and the patrons (no model, but their spot's height). */
export type SpawnKind = ObjectKind | 'patron';

export interface ObjectModel {
  name: string;
  /** World units per model unit (the game's scale for it). */
  scale: number;
  /** x (forward), y (left) and z (up) of each vertex in model units, from the spot it stands on, as in the game. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint16Array;
  /**
   * Its skins by name ('0' the Hidden King's, '1' the Archmother's; one skin, '0', when the teams' look the same or
   * the model is a team's own; the power-up's crystal also has one for each kind, 'gun' and so on, in its colour): per
   * triangle its sRGB colour and how much it glows (0 lit like the map, 255 its own colour), four bytes.
   */
  skins: Map<string, Uint8Array>;
  /** How far its top is above the spot it stands on, in world units. */
  height: number;
}

export interface Spawn {
  kind: SpawnKind;
  /** The frames' team (0 the Hidden King, 1 the Archmother), or null. */
  team: 0 | 1 | null;
  /** World units, as frames have them. */
  x: number;
  y: number;
  z: number;
  /** Which way it faces, in degrees anticlockwise from east (the game's yaw). */
  yaw: number;
}

export interface MapObjects {
  models: Map<string, ObjectModel>;
  spawns: Spawn[];
}

const MAGIC = 0x4a424f4e; // "NOBJ" read as little-endian u32
const KINDS: readonly string[] = ['guardian', 'walker', 'base_guardian', 'patron', 'powerup'];

/** Decodes the (already unzipped) objects file. */
export function decodeObjects(buf: ArrayBuffer): MapObjects {
  const dv = new DataView(buf);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a map objects file');
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`map objects version ${version} is not supported`);
  let p = 8;
  const need = (n: number) => {
    if (p + n > dv.byteLength) throw new Error('map objects file is cut short');
  };
  const u32 = () => (need(4), (p += 4), dv.getUint32(p - 4, true));
  const f32 = () => (need(4), (p += 4), dv.getFloat32(p - 4, true));
  const text = () => {
    need(1);
    const n = dv.getUint8(p);
    need(1 + n);
    const s = String.fromCharCode(...new Uint8Array(buf, p + 1, n));
    p += 1 + n;
    return s;
  };
  // Sections are not aligned for typed array views, so each is copied out.
  const bytes = (n: number) => {
    need(n);
    p += n;
    return buf.slice(p - n, p);
  };

  const models = new Map<string, ObjectModel>();
  for (let m = u32(); m > 0; m--) {
    const name = text();
    const scale = f32();
    const nv = u32();
    const nt = u32();
    const lo = [f32(), f32(), f32()] as const;
    const hi = [f32(), f32(), f32()] as const;
    const skinCount = u32();
    const q = new Uint16Array(bytes(nv * 6));
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) positions[i] = lo[i % 3]! + (q[i]! / 65535) * (hi[i % 3]! - lo[i % 3]!);
    const indices = new Uint16Array(bytes(nt * 6));
    for (const i of indices) if (i >= nv) throw new Error(`map objects: ${name} index out of range`);
    const skins = new Map<string, Uint8Array>();
    for (let s = 0; s < skinCount; s++) {
      const label = text();
      const rgb = new Uint8Array(bytes(nt * 3));
      const glow = new Uint8Array(bytes(nt));
      const packed = new Uint8Array(nt * 4);
      for (let t = 0; t < nt; t++) packed.set([rgb[t * 3]!, rgb[t * 3 + 1]!, rgb[t * 3 + 2]!, glow[t]!], t * 4);
      skins.set(label, packed);
    }
    if (!skins.size) throw new Error(`map objects: ${name} has no skin`);
    models.set(name, { name, scale, positions, indices, skins, height: hi[2] * scale });
  }
  const spawns: Spawn[] = [];
  for (let n = u32(); n > 0; n--) {
    const kind = text();
    need(17);
    const team = dv.getUint8(p);
    const [x, y, z, yaw] = [0, 1, 2, 3].map((i) => dv.getFloat32(p + 1 + i * 4, true)) as [number, number, number, number];
    p += 17;
    if (KINDS.includes(kind)) spawns.push({ kind: kind as SpawnKind, team: team === 0 || team === 1 ? team : null, x, y, z, yaw });
  }
  if (p !== dv.byteLength) throw new Error('map objects file has the wrong length');
  return { models, spawns };
}

/**
 * The model a kind of thing is drawn with for a team, and that team's skin (or the named `skin`: the power-up's are
 * named for its kinds, in their colours); null when there is none.
 */
export function modelFor(
  objects: MapObjects,
  kind: ObjectKind,
  team: 0 | 1 | null,
  skin?: string | null,
): { model: ObjectModel; colours: Uint8Array } | null {
  // Base guardians are a different model for each team; the others have a skin for each (or one for both).
  const model = objects.models.get(kind === 'base_guardian' ? `base_guardian_${team ?? 0}` : kind);
  if (!model) return null;
  const colours = (skin ? model.skins.get(skin) : undefined) ?? model.skins.get(String(team ?? 0)) ?? model.skins.values().next().value;
  return colours ? { model, colours } : null;
}

/** The map's spawn of a kind nearest to world point (x, y), if one is within `reach` world units. */
export function nearestSpawn(objects: MapObjects, kind: SpawnKind, x: number, y: number, reach = 600): Spawn | null {
  let best: Spawn | null = null;
  let bestDistance = reach;
  for (const s of objects.spawns) {
    if (s.kind !== kind) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= bestDistance) {
      best = s;
      bestDistance = d;
    }
  }
  return best;
}

/** How a placement names what it stands for in the frame: an objective by its id, a power-up by its position. */
export const objectiveKey = (id: number) => `o${id}`;
export const powerupKey = (x: number, y: number) => `p${Math.round(x)},${Math.round(y)}`;

/**
 * A frame's height for something the map places (world units), else, in frames from bots older than heights, its
 * spawn's; null when neither is known.
 */
export function heightOf(objects: MapObjects | null, kind: string, x: number, y: number, z: number | null | undefined): number | null {
  if (z != null && Number.isFinite(z)) return z;
  if (!objects || !KINDS.includes(kind)) return null;
  return nearestSpawn(objects, kind as SpawnKind, x, y)?.z ?? null;
}

/** One model standing on the map: world position (x, y as frames have them, z its feet) and facing (degrees). */
export interface Placement {
  /** What it stands for in the frame (objectiveKey, powerupKey). */
  key: string;
  kind: ObjectKind;
  model: ObjectModel;
  colours: Uint8Array;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * What stands on the map in a frame: each standing guardian, walker and base guardian, and each power-up waiting to be
 * picked up. They face the way the map places them, and stand at their spawn's height when the frame has none.
 */
export function placements(objects: MapObjects, frame: LiveFrame | undefined): Placement[] {
  const out: Placement[] = [];
  const place = (key: string, kind: ObjectKind, team: 0 | 1 | null, x: number, y: number, z: number | null | undefined, skin?: string | null) => {
    const look = modelFor(objects, kind, team, skin);
    const spawn = nearestSpawn(objects, kind, x, y);
    const height = z != null && Number.isFinite(z) ? z : spawn?.z;
    if (look && height != null) out.push({ key, kind, ...look, x, y, z: height, yaw: spawn?.yaw ?? 0 });
  };
  for (const o of frame?.objectives ?? []) {
    if (o.kind === 'guardian' || o.kind === 'walker' || o.kind === 'base_guardian') place(objectiveKey(o.id), o.kind, o.team, o.x, o.y, o.z);
  }
  // The power-up's crystal in its kind's colour, as the game tints it (untinted when the kind isn't known).
  for (const pw of frame?.powerups ?? []) place(powerupKey(pw.x, pw.y), 'powerup', null, pw.x, pw.y, pw.z, pw.kind);
  return out;
}

const loading = new Map<string, Promise<MapObjects>>();

/** Fetches and decodes the objects file once per page. */
export function loadObjects(url = OBJECTS_URL): Promise<MapObjects> {
  let objects = loading.get(url);
  if (!objects) {
    objects = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`map objects: HTTP ${res.status}`);
      let buf = await res.arrayBuffer();
      // A server may already have unzipped it (Content-Encoding); otherwise unzip here.
      const head = new Uint8Array(buf, 0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b) {
        buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      return decodeObjects(buf);
    })();
    loading.set(url, objects);
    objects.catch(() => loading.delete(url)); // try again next time
  }
  return objects;
}
