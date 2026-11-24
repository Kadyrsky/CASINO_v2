/**
 * The 3D view's model of the map: Deadlock's own geometry, simplified and coloured by scripts/map_model.py (see its
 * docstring for how and for the file format), served from /maps/<map>.bin.gz.
 *
 * Decoded into map space like the 2D map's: x and y 0–1000 (y down, north at the top) and heights in the same units.
 */
import { MAP_SIZE } from './mapCamera';

/** The game's current map: the usual model, and the more detailed one of the High quality setting. */
export const MODEL_URL = '/maps/dl_midtown.bin.gz';
export const MODEL_URL_HIGH = '/maps/dl_midtown.high.bin.gz';

export interface MapModel {
  /** World units from the middle of the map to the edge of its square (deadlock-api's map radius). */
  radius: number;
  /** x, y and height of each vertex, in map units. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** sRGB colour of each triangle: three bytes. */
  colors: Uint8Array;
  /**
   * Where markers without a height of their own stand (map units) on a groundSize × groundSize grid, rows from the
   * north: on the streets the lowest surface, so under a bridge rather than on it.
   */
  ground: Float32Array;
  groundSize: number;
  /** The Mid-Boss's arena, a hall under the plaza in the middle of the map; null in version 1 files. */
  arena: Arena | null;
  /**
   * The floors of the map's interiors (the arena, the tunnels, the bases' covered courts, big halls: where heroes walk
   * that no camera sees), as triangles; none in files before version 3.
   */
  interiors: Interiors;
}

export interface Interiors {
  /** x, y and height of each corner, in map units. */
  positions: Float32Array;
  /** Three corner indices per triangle. */
  indices: Uint32Array;
  /** Which interior each triangle's floor belongs to (a tunnel, a hall: connected floor). */
  regions: Uint16Array;
}

/** A box on the map (map units, y down) and the height above which what is in it covers it. */
export interface Arena {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  top: number;
}

const MAGIC = 0x50414d4e; // "NMAP" read as little-endian u32

/** Decodes the (already unzipped) model file. */
export function decodeModel(buf: ArrayBuffer): MapModel {
  const dv = new DataView(buf);
  if (dv.byteLength < 32 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a map model');
  const version = dv.getUint32(4, true);
  if (version < 1 || version > 3) throw new Error(`map model version ${version} is not supported`);
  const radius = dv.getFloat32(8, true);
  const zMin = dv.getFloat32(12, true);
  const zMax = dv.getFloat32(16, true);
  const nv = dv.getUint32(20, true);
  const nt = dv.getUint32(24, true);
  const gs = dv.getUint32(28, true);
  let p = 32;
  const box = p + nv * 6 + nt * 12 + nt * 3 + gs * gs * 2;
  // Version 3 adds the interiors after the arena's box: their corner and triangle counts, the corners, the triangles
  // and each triangle's interior.
  const [ni, nf] = version >= 3 && dv.byteLength >= box + 28 ? [dv.getUint32(box + 20, true), dv.getUint32(box + 24, true)] : [0, 0];
  const end = box + (version >= 2 ? 20 : 0) + (version >= 3 ? 8 + ni * 6 + nf * 14 : 0);
  if (dv.byteLength !== end) throw new Error('map model has the wrong length');

  // Sections are not aligned for typed array views, so each is copied out.
  const u16 = (count: number) => {
    const out = new Uint16Array(buf.slice(p, p + count * 2));
    p += count * 2;
    return out;
  };
  const toMap = MAP_SIZE / (2 * radius); // world units → map units
  const height = (q: number) => (zMin + (q / 65535) * (zMax - zMin)) * toMap;
  /** `count` quantized corners (x, y, z) in map space. */
  const corners = (count: number) => {
    const q = u16(count * 3);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      out[i * 3] = (q[i * 3]! / 65535) * MAP_SIZE;
      out[i * 3 + 1] = MAP_SIZE - (q[i * 3 + 1]! / 65535) * MAP_SIZE; // north is +y in the game, up on the map
      out[i * 3 + 2] = height(q[i * 3 + 2]!);
    }
    return out;
  };

  const positions = corners(nv);
  const indices = new Uint32Array(buf.slice(p, p + nt * 12));
  p += nt * 12;
  const colors = new Uint8Array(buf.slice(p, p + nt * 3));
  p += nt * 3;
  const g = u16(gs * gs);
  const ground = new Float32Array(gs * gs);
  for (let i = 0; i < g.length; i++) ground[i] = height(g[i]!);
  for (let i = 0; i < indices.length; i++) if (indices[i]! >= nv) throw new Error('map model index out of range');
  let arena: Arena | null = null;
  if (version >= 2) {
    const [x0, y0, x1, y1, top] = [0, 1, 2, 3, 4].map((i) => dv.getFloat32(p + i * 4, true)) as [number, number, number, number, number];
    p += 20;
    if (x1 > x0 && y1 > y0) {
      const mx = (w: number) => ((w + radius) / (2 * radius)) * MAP_SIZE;
      // y to the north in the file, down on the map: the box's north edge is its smaller map y.
      arena = { x0: mx(x0), x1: mx(x1), y0: MAP_SIZE - mx(y1), y1: MAP_SIZE - mx(y0), top: top * toMap };
    }
  }
  p += version >= 3 ? 8 : 0;
  const floorCorners = corners(ni);
  const floorIndices = new Uint32Array(buf.slice(p, p + nf * 12));
  p += nf * 12;
  const interiors: Interiors = { positions: floorCorners, indices: floorIndices, regions: u16(nf) };
  for (let i = 0; i < floorIndices.length; i++) if (floorIndices[i]! >= ni) throw new Error('map model index out of range');
  return { radius, positions, indices, colors, ground, groundSize: gs, arena, interiors };
}

/** Whether map point (x, y) at height h (map units) is in the arena, under what covers it. */
export function inArena(arena: Arena | null, x: number, y: number, h: number): boolean {
  return !!arena && x > arena.x0 && x < arena.x1 && y > arena.y0 && y < arena.y1 && h < arena.top;
}

/** A height in world units (z, as frames have it) in the model's map units. */
export function mapHeight(model: Pick<MapModel, 'radius'>, z: number): number {
  return (z * MAP_SIZE) / (2 * model.radius);
}

/**
 * Height (map units) where a hero stands at map point (x, y): its own height `z` (world units) when the frame has it,
 * so on a bridge, a roof or in a tunnel; otherwise the ground grid's (frames from older bots).
 */
export function standHeight(model: MapModel, x: number, y: number, z: number | null | undefined): number {
  return z != null && Number.isFinite(z) ? mapHeight(model, z) : groundHeight(model, x, y);
}

/** Height (map units) where a marker stands at map point (x, y), interpolated between grid cells. */
export function groundHeight(model: MapModel, x: number, y: number): number {
  const n = model.groundSize;
  const gx = Math.min(n - 1, Math.max(0, (x / MAP_SIZE) * n - 0.5));
  const gy = Math.min(n - 1, Math.max(0, (y / MAP_SIZE) * n - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const g = model.ground;
  const top = g[y0 * n + x0]! * (1 - fx) + g[y0 * n + x1]! * fx;
  const bottom = g[y1 * n + x0]! * (1 - fx) + g[y1 * n + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

const loading = new Map<string, Promise<MapModel>>();

/** Fetches and decodes a model once per page. */
export function loadModel(url = MODEL_URL): Promise<MapModel> {
  let model = loading.get(url);
  if (!model) {
    model = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`map model: HTTP ${res.status}`);
      let buf = await res.arrayBuffer();
      // A server may already have unzipped it (Content-Encoding); otherwise unzip here.
      const head = new Uint8Array(buf, 0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b) {
        buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      return decodeModel(buf);
    })();
    loading.set(url, model);
    model.catch(() => loading.delete(url)); // try again next time
  }
  return model;
}
