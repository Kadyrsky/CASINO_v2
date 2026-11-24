/**
 * The camera of the realtime map's 2.5D view: a perspective camera that looks down at the map from a fixed distance,
 * tilted towards the horizon and turned around the vertical axis.
 *
 * Map space is the 2D map's: a 0–1000 square, x to the right (east) and y down (south). Heights are in the same
 * units, upwards. Zooming changes the focal length instead of moving the camera closer, so the whole map always stays
 * in front of the camera, whatever the pan, turn or tilt (a point behind it would break the projection).
 */

export interface Camera {
  /** The map point in the middle of the view. */
  x: number;
  y: number;
  /** Magnification: 1 shows the whole map at the default tilt. */
  zoom: number;
  /** Turn around the vertical axis, in radians. 0 has north (the 2D map's top) at the top; more turns the map anticlockwise. */
  yaw: number;
  /** Tilt in radians from looking straight down. */
  tilt: number;
}

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
}

/** A map point on the screen. */
export interface ScreenPoint {
  /** CSS pixels from the viewport's top left corner. */
  x: number;
  y: number;
  /** Distance from the camera along its view direction, in map units: larger is further away. */
  depth: number;
  /** Screen pixels per map unit at that depth. */
  scale: number;
}

export type Projector = (x: number, y: number, h?: number) => ScreenPoint;

export const MAP_SIZE = 1000;
/** From the camera to the point it looks at, in map units. Smaller makes the perspective stronger. */
export const DISTANCE = 1700;
export const DEFAULT_TILT = rad(52);
export const MAX_TILT = rad(62);
export const MAX_ZOOM = 8;
/** How far one can zoom out from the whole-map view at the current tilt. */
const ZOOM_OUT = 0.8;

export function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** An angle in (-π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Camera-space coordinates of a map point: to the right, up, and depth (along the view direction). */
function toCamera(cam: Camera, x: number, y: number, h: number): [number, number, number] {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const ct = Math.cos(cam.tilt);
  const st = Math.sin(cam.tilt);
  const dx = x - cam.x;
  const dy = y - cam.y;
  const a = dx * cy + dy * sy; // to the right on screen
  const b = dx * sy - dy * cy; // along the ground, away from the camera
  return [a, b * ct + h * st, DISTANCE + b * st - h * ct];
}

/**
 * The map point at height `h` seen at (u, v): screen offsets from the middle of the view divided by the focal length,
 * v upwards. Null at or above the horizon.
 */
function groundAt(cam: Camera, u: number, v: number, h = 0): [number, number] | null {
  const ct = Math.cos(cam.tilt);
  const st = Math.sin(cam.tilt);
  const den = ct - v * st;
  if (den < 1e-3) return null;
  const b = (v * (DISTANCE - h * ct) - h * st) / den;
  const a = u * (DISTANCE + b * st - h * ct);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  return [cam.x + a * cy + b * sy, cam.y + a * sy - b * cy];
}

/** The map's playable area: the minimap's content lies inside the circle inscribed in its square. */
const RIM: [number, number][] = Array.from({ length: 48 }, (_, i) => {
  const t = (i / 48) * 2 * Math.PI;
  return [MAP_SIZE / 2 + (MAP_SIZE / 2) * Math.cos(t), MAP_SIZE / 2 + (MAP_SIZE / 2) * Math.sin(t)];
});

/** Room around the whole map, as shares of the viewport: more at the top, where the far markers stand up. */
const MARGIN = { left: 0.03, right: 0.03, top: 0.1, bottom: 0.04 };

interface Fit {
  x: number;
  y: number;
  focal: number;
}

const fits = new Map<string, Fit>();

/**
 * The focal length and target that show the whole map at `tilt`, north up, in the middle of the margins; `topRoom`
 * is the share of the height left free at the top, for what stands up at the far side.
 */
function fit(vp: Viewport, tilt: number, topRoom = MARGIN.top): Fit {
  const key = `${vp.width}x${vp.height}@${tilt.toFixed(5)}^${topRoom}`;
  const hit = fits.get(key);
  if (hit) return hit;
  const left = vp.width * MARGIN.left;
  const right = vp.width * MARGIN.right;
  const top = vp.height * topRoom;
  const bottom = vp.height * MARGIN.bottom;
  const roomX = Math.max(1, vp.width - left - right);
  const roomY = Math.max(1, vp.height - top - bottom);
  let cam: Camera = { x: MAP_SIZE / 2, y: MAP_SIZE / 2, zoom: 1, yaw: 0, tilt };
  let focal = 1;
  // The perspective makes the map's near side larger, so its middle isn't the target's: move the target until the
  // map sits in the middle of the room left by the margins.
  for (let i = 0; i < 8; i++) {
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, y] of RIM) {
      const [a, up, depth] = toCamera(cam, x, y, 0);
      u0 = Math.min(u0, a / depth);
      u1 = Math.max(u1, a / depth);
      v0 = Math.min(v0, up / depth);
      v1 = Math.max(v1, up / depth);
    }
    focal = Math.min(roomX / (u1 - u0), roomY / (v1 - v0));
    const wantU = (left - right) / 2 / focal;
    const wantV = (bottom - top) / 2 / focal;
    const g = groundAt(cam, (u0 + u1) / 2 - wantU, (v0 + v1) / 2 - wantV);
    if (!g) break;
    cam = { ...cam, x: g[0], y: g[1] };
  }
  if (fits.size > 64) fits.clear();
  const result = { x: cam.x, y: cam.y, focal };
  fits.set(key, result);
  return result;
}

/**
 * The whole map, north up, at the default tilt. `topRoom` (a share of the height) leaves more room at the top for tall
 * scenery at the far side; the zoom is then a little under 1.
 */
export function homeView(vp: Viewport, topRoom = MARGIN.top): Camera {
  const f = fit(vp, DEFAULT_TILT, topRoom);
  return { x: f.x, y: f.y, zoom: f.focal / fit(vp, DEFAULT_TILT).focal, yaw: 0, tilt: DEFAULT_TILT };
}

/** Focal length in CSS pixels. */
export function focalLength(cam: Camera, vp: Viewport): number {
  return cam.zoom * fit(vp, DEFAULT_TILT).focal;
}

/** Smallest and largest zoom: out to a little more than the whole map at the current tilt, in to MAX_ZOOM. */
export function zoomLimits(cam: Camera, vp: Viewport): [number, number] {
  const tilt = clamp(cam.tilt, 0, MAX_TILT);
  return [(ZOOM_OUT * fit(vp, tilt).focal) / fit(vp, DEFAULT_TILT).focal, MAX_ZOOM];
}

/** The camera within its limits: target on the map, zoom and tilt in range, yaw in (-π, π]. */
export function clampCamera(cam: Camera, vp: Viewport): Camera {
  const tilt = clamp(cam.tilt, 0, MAX_TILT);
  const [lo, hi] = zoomLimits({ ...cam, tilt }, vp);
  return {
    x: clamp(cam.x, 0, MAP_SIZE),
    y: clamp(cam.y, 0, MAP_SIZE),
    zoom: clamp(cam.zoom, lo, hi),
    yaw: wrapAngle(cam.yaw),
    tilt,
  };
}

/** Projects map points (x, y at height h) to the screen. */
export function projector(cam: Camera, vp: Viewport): Projector {
  const f = focalLength(cam, vp);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const ct = Math.cos(cam.tilt);
  const st = Math.sin(cam.tilt);
  const hw = vp.width / 2;
  const hh = vp.height / 2;
  return (x, y, h = 0) => {
    const dx = x - cam.x;
    const dy = y - cam.y;
    const a = dx * cy + dy * sy;
    const b = dx * sy - dy * cy;
    const depth = DISTANCE + b * st - h * ct;
    const s = f / depth;
    return { x: hw + a * s, y: hh - (b * ct + h * st) * s, depth, scale: s };
  };
}

/** The map point (at height h) under a screen point, or null when that is at or above the horizon. */
export function unproject(cam: Camera, vp: Viewport, sx: number, sy: number, h = 0): [number, number] | null {
  const f = focalLength(cam, vp);
  return groundAt(cam, (sx - vp.width / 2) / f, -(sy - vp.height / 2) / f, h);
}

/**
 * `cam` moved (not turned or zoomed) so that the map point `ground`, at height h, is under the screen point (sx, sy).
 */
export function anchored(cam: Camera, vp: Viewport, sx: number, sy: number, ground: [number, number], h = 0): Camera {
  const now = unproject(cam, vp, sx, sy, h);
  return now ? { ...cam, x: cam.x + ground[0] - now[0], y: cam.y + ground[1] - now[1] } : cam;
}

/** Zoom by `factor` (> 1 zooms in), keeping the map point under (sx, sy), on the plane at height h, where it is. */
export function zoomAround(cam: Camera, vp: Viewport, factor: number, sx: number, sy: number, h = 0): Camera {
  const ground = unproject(cam, vp, sx, sy, h);
  const [lo, hi] = zoomLimits(cam, vp);
  const next = { ...cam, zoom: clamp(cam.zoom * factor, lo, hi) };
  return clampCamera(ground ? anchored(next, vp, sx, sy, ground, h) : next, vp);
}

/**
 * How much the 2D markers grow when zoomed in: slower than the map, as on the 2D map, so a zoomed-in view shows more
 * room between them.
 */
export function markerZoom(zoom: number): number {
  return Math.max(Math.sqrt(zoom), 0.45 * zoom);
}

/** How flat a circle lying on the ground looks at `depth`: its height on screen over its width. */
export function groundSquash(cam: Camera, depth: number): number {
  return (Math.cos(cam.tilt) * DISTANCE) / depth;
}

/** The rows of the projection over (x, y, h, 1): screen right and up (in focal lengths), and depth. */
function rows(cam: Camera) {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const ct = Math.cos(cam.tilt);
  const st = Math.sin(cam.tilt);
  const a0 = -(cy * cam.x + sy * cam.y);
  const b0 = -(sy * cam.x - cy * cam.y);
  return {
    right: [cy, sy, 0, a0],
    up: [ct * sy, -ct * cy, st, ct * b0],
    depth: [st * sy, -st * cy, -ct, DISTANCE + st * b0],
  };
}

/** Column-major 4×4 matrix from map space (x, y, h, 1) to WebGL clip space. */
export function clipMatrix(cam: Camera, vp: Viewport, near = 50, far = 6000): Float32Array {
  const f = focalLength(cam, vp);
  const r = rows(cam);
  const kx = (2 * f) / vp.width;
  const ky = (2 * f) / vp.height;
  // Depth: -1 at `near`, 1 at `far`.
  const za = (far + near) / (far - near);
  const zb = (-2 * far * near) / (far - near);
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    m[c * 4] = kx * r.right[c]!;
    m[c * 4 + 1] = ky * r.up[c]!;
    m[c * 4 + 2] = za * r.depth[c]! + (c === 3 ? zb : 0);
    m[c * 4 + 3] = r.depth[c]!;
  }
  return m;
}

/**
 * CSS `matrix3d` that lays a MAP_SIZE × MAP_SIZE px element (transform-origin 0 0, at the viewport's top left) on the
 * map plane, for drawing the map without WebGL.
 */
export function cssMatrix(cam: Camera, vp: Viewport): string {
  const f = focalLength(cam, vp);
  const r = rows(cam);
  const hw = vp.width / 2;
  const hh = vp.height / 2;
  const cols: number[] = [];
  for (let c = 0; c < 4; c++) {
    const w = c === 2 ? 0 : r.depth[c]!; // the element is flat: its own z stays 0
    cols.push(
      c === 2 ? 0 : f * r.right[c]! + hw * w,
      c === 2 ? 0 : -f * r.up[c]! + hh * w,
      c === 2 ? 1 : 0,
      w,
    );
  }
  return `matrix3d(${cols.map((v) => +v.toFixed(6)).join(',')})`;
}

/**
 * Canvas pixels per CSS pixel: the screen's own (at most 2), or for the High quality setting twice that (at most 3),
 * which the browser then scales down, smoothing edges. Never more than `maxSide` canvas pixels on a side.
 */
export function canvasScale(vp: Viewport, devicePixelRatio: number, high: boolean, maxSide = 8192): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const k = high ? Math.min(3, dpr * 2) : Math.min(2, dpr);
  return Math.min(k, maxSide / Math.max(vp.width, vp.height, 1));
}
