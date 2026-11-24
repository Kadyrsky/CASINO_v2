/**
 * The realtime map's 2.5D and 3D views: the map tilted in perspective (WebGL), with the heroes, objectives, camps, the
 * Soul Urn and the Unstable Rift standing on it as upright markers (SVG, the 2D map's own markers). The 2.5D view
 * ("terrain") raises the buildings traced from the minimap image; the 3D view ("model") shows the game's own map
 * geometry, simplified and in its colours (mapModel.ts), with the markers on its streets. Turning and tilting happen
 * around the middle of the view, and switching between the two keeps it.
 *
 * Mouse: drag to pan, scroll to zoom at the pointer, right-drag (or Ctrl-drag) to turn and tilt, double-click for the
 * whole map. Touch: one finger pans; two fingers pinch to zoom and twist to turn. Keys, once the map has focus: arrows
 * pan, + and − zoom, Q and E turn, Page Up and Page Down tilt, 0 shows the whole map.
 */
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import type { CampKind, FrameCamp, FrameObjective, FrameSinner, LiveAssets, LiveFrame } from '../api/types';
import { TEAM_COLOR } from '../lib/live';
import {
  DEFAULT_TILT,
  DISTANCE,
  MAP_SIZE,
  anchored,
  canvasScale,
  clampCamera,
  clipMatrix,
  cssMatrix,
  focalLength,
  groundSquash,
  homeView,
  markerZoom,
  projector,
  rad,
  unproject,
  wrapAngle,
  zoomAround,
  type Camera,
  type ScreenPoint,
  type Viewport,
} from '../lib/mapCamera';
import { InteriorIndex, sameOpenings, type Footing, type Opening } from '../lib/mapInteriors';
import { MODEL_URL, MODEL_URL_HIGH, groundHeight, inArena, loadModel, mapHeight, standHeight, type MapModel } from '../lib/mapModel';
import { ModelRenderer } from '../lib/mapModelRenderer';
import { ObjectRenderer, type ObjectDraw } from '../lib/mapObjectRenderer';
import { heightOf, loadObjects, objectiveKey, placements, powerupKey, type MapObjects } from '../lib/mapObjects';
import { TerrainRenderer, webgl, type Rgb, type TerrainColors } from '../lib/mapRenderer';
import { BUILDING_HEIGHT, loadTerrain, type Terrain } from '../lib/mapTerrain';
import { CampMarker, MapScale, MidbossTimer, PowerupMarker } from './liveMapLayers';
import { HeroMarker, OBJECTIVE_SIZE, ObjectiveMarker, RIFT_COLOR, RiftMarker, URN_COLOR, UrnCarried, UrnDelivery, UrnMarker, objectiveColor } from './liveMapMarkers';

export interface MapLayers {
  lanes: boolean;
  objectives: boolean;
  camps: boolean;
  names: boolean;
  /** 2.5D view only: the buildings stand up (off: their footprints lie flat on the map). */
  buildings: boolean;
}

/**
 * How finely the views are drawn. High: twice the pixels (scaled down, for smooth edges) and, in 3D, the game's map in
 * more detail with the sun's shadows.
 */
export type MapQuality = 'standard' | 'high';

/** How high markers stand above the ground, in marker units (a hero's disc is 34 across). */
const HERO_LIFT = 26;
const CAMP_LIFT = 4;
const OBJECTIVE_LIFT: Record<FrameObjective['kind'], number> = {
  patron: 62,
  patron_core: 46,
  walker: 50,
  guardian: 36,
  base_guardian: 30,
  midboss: 28,
};
/** The stem between a model's head and its marker (which stands clear of the head), in marker units. */
const MODEL_LIFT = 8;
/** Half the height of the power-up's marker, in marker units (see PowerupGlyph). */
const POWERUP_HALF = 13;
/**
 * The models standing on the 3D map (guardians, walkers, base guardians, power-ups) are this many times their size
 * with the whole map in view, so they read among buildings ten times their height; zoomed in, they shrink towards their
 * true size the way markers do.
 */
const MODEL_GROW = 2.5;
/** Team light on the ground around objectives, in map units. */
const GLOW_RADIUS = 24;
/**
 * In the 3D view, how far the ziplines (lanes) hang above the streets, in map units (about 400 world units), when the
 * map assets have no heights for them (assets from before zipline heights).
 */
const LANE_LIFT = 18;
/** Far markers are drawn smaller, though less than true perspective (1) would, so they stay readable. */
const MARKER_PERSPECTIVE = 0.75;
/** An interior stays open this long after its hero leaves its floor (a jump, a dash), in milliseconds. */
const OPEN_HOLD_MS = 900;
const TURN_PER_PX = rad(0.45);
const TILT_PER_PX = rad(0.3);
const STEP_ZOOM = 1.5;
const STEP_TURN = rad(45);
const ORIGIN: [number, number] = [0, 0];

function parseHex(v: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

/** The terrain's colours, from the theme's ink shades, so the map matches the page in every theme. */
function themeColors(): TerrainColors {
  const style = getComputedStyle(document.documentElement);
  const ink = (shade: number, fallback: string) => parseHex(style.getPropertyValue(`--color-ink-${shade}`)) ?? parseHex(fallback)!;
  return {
    street: ink(800, '#1d1a28'),
    streetShade: ink(950, '#0b0a10'),
    wall: ink(500, '#5b5573'),
    roof: ink(600, '#3a3550'),
    roofEdge: ink(400, '#8a83a3'),
    edge: ink(700, '#2a2638'),
  };
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Ids sorted far to near, for drawing nearer markers over farther ones. */
function byDepth<T>(items: T[], id: (t: T) => number, where: (t: T) => ScreenPoint | null): number[] {
  const list: [number, number][] = [];
  for (const t of items) {
    const s = where(t);
    if (s) list.push([id(t), s.depth]);
  }
  return list.sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

const sameOrder = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Children drawn upright at a screen point, `lift` pixels above it, with markers scaled by `k`. */
function Stand(props: { s: ScreenPoint; lift: number; k: number; children: JSX.Element }) {
  return (
    <g transform={`translate(${props.s.x.toFixed(1)} ${(props.s.y - props.lift).toFixed(1)})`}>
      <MapScale.Provider value={() => props.k}>{props.children}</MapScale.Provider>
    </g>
  );
}

export function LiveMap25D(props: {
  /** What the map is made of: buildings raised from the minimap (2.5D), or the game's own geometry (3D). */
  scene: 'terrain' | 'model';
  quality: MapQuality;
  frame?: LiveFrame;
  assets?: LiveAssets;
  /** World position → 0–1 map position, as on the 2D map. */
  at: (x: number, y: number) => [number, number];
  /** A hero's interpolated 0–1 map position. */
  heroAt: (id: number | null) => [number, number] | null;
  /** A hero's interpolated height in world units (null in frames from older bots). */
  heroZ: (id: number | null) => number | null;
  layers: MapLayers;
  selected: number | null;
  onSelect: (id: number | null) => void;
  label: (id: number) => string;
  campKind: (c: FrameCamp) => CampKind;
  sinnerAt: (x: number, y: number) => FrameSinner | undefined;
  carrierTeam: 0 | 1 | null;
  /** Keep the selected hero in the middle (zooms in when it starts). */
  follow: boolean;
}) {
  // oxlint-disable-next-line no-unassigned-vars -- assigned by Solid's ref={el}
  let el!: HTMLDivElement;
  // oxlint-disable-next-line no-unassigned-vars -- assigned by Solid's ref={canvas}
  let canvas!: HTMLCanvasElement;
  const [vp, setVp] = createSignal<Viewport>({ width: 0, height: 0 });
  const [cam, setCam] = createSignal<Camera | null>(null);
  const [colors, setColors] = createSignal<TerrainColors | null>(null);
  const [hinted, setHinted] = createSignal(false);
  /** No WebGL: the flat minimap is shown in perspective instead. */
  const [glFailed, setGlFailed] = createSignal(false);
  const set = (c: Camera) => setCam(clampCamera(c, vp()));

  // ---- camera animation (buttons, keys, double-click, following) ----
  let anim = 0;
  /** Where the running glide ends, for the parts of the camera it moves. */
  let gliding: Partial<Camera> = {};
  const stopAnimation = () => {
    cancelAnimationFrame(anim);
    anim = 0;
    gliding = {};
  };
  /** The camera as it will be when the glide ends, so quick steps from buttons and keys add up. */
  const target = (): Camera | null => {
    const c = cam();
    return c && { ...c, ...gliding };
  };
  /** Glides the given parts of the camera to new values; the others stay free (following moves the target). */
  const animateTo = (to: Partial<Camera>, ms = 320) => {
    const from = cam();
    if (!from) return;
    const parts = { ...gliding, ...to };
    cancelAnimationFrame(anim);
    const goal = clampCamera({ ...from, ...parts }, vp());
    gliding = Object.fromEntries(Object.keys(parts).map((k) => [k, goal[k as keyof Camera]]));
    if (prefersReducedMotion()) {
      stopAnimation();
      return set(goal);
    }
    const moves = (k: keyof Camera) => k in parts;
    const turn = wrapAngle(goal.yaw - from.yaw);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - t) ** 3;
      const c = cam() ?? from;
      setCam({
        x: moves('x') ? from.x + (goal.x - from.x) * e : c.x,
        y: moves('y') ? from.y + (goal.y - from.y) * e : c.y,
        zoom: moves('zoom') ? from.zoom * (goal.zoom / from.zoom) ** e : c.zoom,
        yaw: moves('yaw') ? wrapAngle(from.yaw + turn * e) : c.yaw,
        tilt: moves('tilt') ? from.tilt + (goal.tilt - from.tilt) * e : c.tilt,
      });
      if (t < 1) anim = requestAnimationFrame(step);
      else stopAnimation();
    };
    anim = requestAnimationFrame(step);
  };
  /** The whole map; the 3D view keeps more room at the top for the tall buildings at the far side. */
  const homeOf = (v: Viewport) => homeView(v, props.scene === 'model' ? 0.24 : undefined);
  const home = () => {
    stopAnimation();
    animateTo(homeOf(vp()));
  };
  const zoomBy = (f: number) => animateTo({ zoom: (target()?.zoom ?? 1) * f });
  const turnBy = (a: number) => animateTo({ yaw: (target()?.yaw ?? 0) + a });
  const tiltBy = (a: number) => animateTo({ tilt: (target()?.tilt ?? DEFAULT_TILT) + a });
  /** Moves the view by a screen offset (pixels). */
  const panBy = (dx: number, dy: number) => {
    const c = cam();
    const g = c && unproject(c, vp(), vp().width / 2 + dx, vp().height / 2 + dy, anchorHeight());
    if (g) animateTo({ x: g[0], y: g[1] }, 220);
  };
  onCleanup(stopAnimation);

  // ---- projection ----
  const proj = createMemo(() => {
    const c = cam();
    const v = vp();
    return c && v.width > 0 && v.height > 0 ? projector(c, v) : null;
  });
  const tilt = () => cam()?.tilt ?? DEFAULT_TILT;
  /** Marker scale at the target: map-sized at zoom 1 (like the 2D map), then growing slower than the map. */
  const markerBase = createMemo(() => {
    const c = cam();
    const v = vp();
    return c && v.width > 0 ? (focalLength({ ...c, zoom: 1 }, v) / DISTANCE) * markerZoom(c.zoom) : 1;
  });
  const scaleAt = (depth: number) => markerBase() * (DISTANCE / depth) ** MARKER_PERSPECTIVE;
  /** Screen pixels a marker `units` tall rises at scale k (none when looking straight down). */
  const rise = (units: number, k: number) => units * k * Math.sin(tilt());
  const squash = (depth: number) => {
    const c = cam();
    return c ? groundSquash(c, depth) : 1;
  };
  // ---- the 3D view's model: loaded the first time it is shown; in high quality the detailed one ----
  const [model, setModel] = createSignal<{ state: 'idle' | 'loading' | 'ready' | 'failed'; data: MapModel | null }>({ state: 'idle', data: null });
  /** The model being loaded or shown. */
  let wanted: string | null = null;
  const fetchModel = (url: string) => {
    wanted = url;
    setModel((m) => ({ state: 'loading', data: m.data })); // the model shown stays until the other one is here
    loadModel(url).then(
      (data) => {
        if (wanted === url) setModel({ state: 'ready', data });
      },
      () => {
        if (wanted !== url) return;
        if (url === MODEL_URL_HIGH) fetchModel(MODEL_URL); // no detailed model: the usual one
        else setModel({ state: 'failed', data: null });
      },
    );
  };
  createEffect(() => {
    if (props.scene !== 'model') return;
    const url = props.quality === 'high' ? MODEL_URL_HIGH : MODEL_URL;
    if (url !== wanted) untrack(() => fetchModel(url));
  });
  /** The model the markers stand on, while the 3D view shows it. */
  const shownModel = () => (props.scene === 'model' && !glFailed() ? model().data : null);
  /**
   * Whether a living hero is down in the Mid-Boss's arena (a hall under the plaza in the middle of the map), which
   * then stands open like any interior with a hero in it (see openings).
   */
  const arenaOpen = createMemo(() => {
    const m = shownModel();
    if (!m?.arena) return false;
    return (props.frame?.players ?? []).some((p) => {
      const xy = p.alive ? props.heroAt(p.account_id) : null;
      const z = props.heroZ(p.account_id);
      return !!xy && z != null && inArena(m.arena, xy[0] * MAP_SIZE, xy[1] * MAP_SIZE, mapHeight(m, z));
    });
  });
  /**
   * Height (map units) something stands at, at map point (x, y): in 3D its own height z (world units, as frames have
   * it) when known, so on a bridge, a roof or in a tunnel, else the model's ground there (the lower level where a
   * bridge or tunnel crosses); in 2.5D the ground plane. In the arena while it is closed (the Mid-Boss, when nobody
   * fights it): on the plaza above, where it can be seen.
   */
  const standAt = (x: number, y: number, z?: number | null) => {
    const m = shownModel();
    if (!m) return 0;
    if (z != null && !arenaOpen() && inArena(m.arena, x, y, mapHeight(m, z))) return groundHeight(m, x, y);
    return standHeight(m, x, y, z);
  };
  /** The plane a drag holds on to: the usual street height in 3D, so the streets follow the pointer. */
  const anchorHeight = createMemo(() => {
    const m = shownModel();
    if (!m) return 0;
    const g = Array.from(m.ground).sort((a, b) => a - b);
    return g[Math.floor(g.length / 2)] ?? 0;
  });

  // ---- the game's models of the guardians, walkers, base guardians and bridge power-ups, standing on the 3D map ----
  const [objects, setObjects] = createSignal<MapObjects | null>(null);
  createEffect(() => {
    if (props.scene !== 'model' || objects()) return;
    let live = true;
    loadObjects().then(
      (o) => live && setObjects(o),
      () => undefined, // without them, the markers stand on the map alone
    );
    onCleanup(() => (live = false));
  });
  /** An objective's or power-up's height (world units): the frame's, else (older bots) where the map places it. */
  const zOf = (kind: string, x: number, y: number, z: number | null | undefined) => heightOf(objects(), kind, x, y, z);
  /** The models standing on the map, in map units: while the 3D view shows its model and the objectives. */
  const standing = createMemo<(ObjectDraw & { key: string })[]>(
    () => {
      const o = objects();
      if (!o || !shownModel() || !props.layers.objectives) return [];
      return placements(o, props.frame).map((s) => {
        const m = props.at(s.x, s.y);
        const x = m[0] * MAP_SIZE;
        const y = m[1] * MAP_SIZE;
        return { key: s.key, model: s.model, colours: s.colours, x, y, h: standAt(x, y, s.z), yaw: s.yaw };
      });
    },
    [],
    {
      // Frames come twice a second with the same objectives standing: only a change needs drawing again.
      equals: (a, b) =>
        a.length === b.length &&
        a.every((d, i) => {
          const e = b[i]!;
          return d.key === e.key && d.colours === e.colours && d.x === e.x && d.y === e.y && d.h === e.h && d.yaw === e.yaw;
        }),
    },
  );
  const standingByKey = createMemo(() => new Map(standing().map((d) => [d.key, d])));
  /** How many times their size the models are drawn at this zoom (see MODEL_GROW). */
  const grow = () => {
    const z = cam()?.zoom ?? 1;
    return Math.min(MODEL_GROW, Math.max(1, (MODEL_GROW * markerZoom(z)) / z));
  };
  /** Where on the screen the top of a standing model is (its marker stands there), or null. */
  const topOf = (key: string) => {
    const d = standingByKey().get(key);
    const p = proj();
    const m = shownModel();
    return d && p && m ? p(d.x, d.y, d.h + mapHeight(m, d.model.height * grow())) : null;
  };

  /** A world position (x, y and height z as in frames) on the screen, standing where standAt says. */
  const ground = (x: number, y: number, z?: number | null) => {
    const p = proj();
    if (!p) return null;
    const m = props.at(x, y);
    const mx = m[0] * MAP_SIZE;
    const my = m[1] * MAP_SIZE;
    return p(mx, my, standAt(mx, my, z));
  };
  /** Height (map units) a hero stands at. */
  const heroHeight = (id: number | null, x: number, y: number) => standAt(x, y, props.heroZ(id));
  const heroGround = (id: number | null) => {
    const p = proj();
    const xy = props.heroAt(id);
    if (!p || !xy) return null;
    const x = xy[0] * MAP_SIZE;
    const y = xy[1] * MAP_SIZE;
    return p(x, y, heroHeight(id, x, y));
  };

  // ---- what is on the map ----
  const players = () => props.frame?.players ?? [];
  const playerById = createMemo(() => new Map(players().map((p) => [p.account_id, p])));
  const objectiveById = createMemo(() => new Map((props.frame?.objectives ?? []).map((o) => [o.id, o])));
  const campById = createMemo(() => new Map((props.frame?.camps ?? []).map((c) => [c.id, c])));
  const heroOrder = createMemo(() => byDepth(players(), (p) => p.account_id, (p) => heroGround(p.account_id)), [], { equals: sameOrder });
  /** Where an objective stands: at its height (the frame's, else where the map places it). */
  const objectiveGround = (o: FrameObjective) => ground(o.x, o.y, zOf(o.kind, o.x, o.y, o.z));
  const objectiveOrder = createMemo(() => byDepth(props.frame?.objectives ?? [], (o) => o.id, objectiveGround), [], { equals: sameOrder });
  const campOrder = createMemo(() => byDepth(props.frame?.camps ?? [], (c) => c.id, (c) => ground(c.x, c.y, c.z)), [], { equals: sameOrder });
  const midbossAlive = () => !!props.frame?.objectives.some((o) => o.kind === 'midboss');
  const urnCarrier = () => props.frame?.urn?.carrier ?? null;

  // ---- interiors (3D): where a hero stands that no camera sees, the map in front of it is cut away ----
  const interiors = createMemo(() => {
    const m = shownModel();
    return m ? InteriorIndex.of(m) : null;
  });
  /** Where each hero last stood in an interior, and when: it stays open a moment after (see OPEN_HOLD_MS). */
  const lastInside = new Map<number, Footing & { at: number }>();
  const [recheck, setRecheck] = createSignal(0);
  let recheckTimer = 0;
  onCleanup(() => clearTimeout(recheckTimer));
  /** The heroes in interiors, each opening the floor around it. */
  const openings = createMemo<Opening[]>(
    () => {
      recheck();
      const index = interiors();
      if (!index) return [];
      const now = performance.now();
      const out: Opening[] = [];
      let soonest = Infinity;
      for (const p of players()) {
        const xy = p.alive ? props.heroAt(p.account_id) : null;
        if (!xy) {
          lastInside.delete(p.account_id);
          continue;
        }
        const x = xy[0] * MAP_SIZE;
        const y = xy[1] * MAP_SIZE;
        const footing = index.footing(x, y, heroHeight(p.account_id, x, y));
        const last = lastInside.get(p.account_id);
        if (footing) {
          lastInside.set(p.account_id, { ...footing, at: now });
          out.push({ x, y, ...footing });
        } else if (last && now - last.at < OPEN_HOLD_MS) {
          out.push({ x, y, floor: last.floor, region: last.region });
          soonest = Math.min(soonest, last.at + OPEN_HOLD_MS - now);
        } else {
          lastInside.delete(p.account_id);
        }
      }
      // A hero standing still just outside wouldn't run this again: close its interior when the moment is up.
      clearTimeout(recheckTimer);
      if (soonest < Infinity) recheckTimer = window.setTimeout(() => setRecheck((n) => n + 1), soonest + 20);
      return out;
    },
    [],
    { equals: sameOpenings },
  );
  /** The slices the renderer cuts the map down to (mapInteriors.ts), or null while no interior is open. */
  const slices = createMemo(() => {
    const index = interiors();
    const o = openings();
    return index && o.length ? index.slices(o) : null;
  });

  // ---- terrain: traced from the minimap image, drawn with WebGL; the flat image when either isn't available ----
  const [terrain, setTerrain] = createSignal<{ state: 'loading' | 'ready' | 'none' | 'failed'; data: Terrain | null }>({ state: 'loading', data: null });
  // Refetched assets are new objects: trace again only when the image itself changes.
  const imageUrl = createMemo(() => props.assets?.map.image ?? null);
  const hasAssets = createMemo(() => !!props.assets);
  createEffect(() => {
    const url = imageUrl();
    if (!url) {
      setTerrain({ state: hasAssets() ? 'none' : 'loading', data: null });
      return;
    }
    let live = true;
    setTerrain({ state: 'loading', data: null });
    loadTerrain(url).then(
      (data) => live && setTerrain({ state: 'ready', data }),
      () => live && setTerrain({ state: 'failed', data: null }),
    );
    onCleanup(() => (live = false));
  });
  const flatImage = () =>
    glFailed() || (props.scene === 'terrain' ? terrain().state === 'failed' : model().state === 'failed') ? imageUrl() : null;

  // ---- drawing: one WebGL context, a renderer for each scene made when first needed ----
  let gl: WebGLRenderingContext | null = null;
  let terrainRenderer: TerrainRenderer | null = null;
  let modelRenderer: ModelRenderer | null = null;
  let objectRenderer: ObjectRenderer | null = null;
  let drawFrame = 0;
  const drawNow = () => {
    cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    const c = cam();
    const v = vp();
    const col = colors();
    if (!gl || !c || !v.width || !col) return;
    const matrix = clipMatrix(c, v);
    if (props.scene === 'model') {
      if (!modelRenderer) {
        modelRenderer = ModelRenderer.create(canvas, gl, drawNow);
        if (!modelRenderer) return setGlFailed(true);
        modelRenderer.setModel(model().data);
      }
      objectRenderer ??= ObjectRenderer.create(gl);
      modelRenderer.setShadows(props.quality === 'high');
      modelRenderer.setSlices(slices());
      const list = standing();
      const radius = shownModel()?.radius;
      const size = grow();
      const models = objectRenderer && list.length && radius ? () => objectRenderer?.draw(matrix, list, radius, size) : undefined;
      modelRenderer.draw(matrix, models); // nothing until the model has loaded
      return;
    }
    if (!terrainRenderer) {
      terrainRenderer = TerrainRenderer.create(canvas, gl, drawNow);
      if (!terrainRenderer) return setGlFailed(true);
      terrainRenderer.setTerrain(terrain().data);
    }
    // While the terrain is traced, nothing rather than a plain board that would then change.
    const t = terrain().state;
    if (t === 'loading' || t === 'failed') terrainRenderer.clear();
    else terrainRenderer.draw(matrix, col, props.layers.buildings);
  };
  const draw = () => {
    if (!drawFrame) drawFrame = requestAnimationFrame(drawNow);
  };
  createEffect(() => {
    const data = terrain().data; // read first: `terrainRenderer?.` would skip it while there is none yet
    terrainRenderer?.setTerrain(data);
    draw();
  });
  createEffect(() => {
    const data = model().data;
    modelRenderer?.setModel(data);
    draw();
  });
  createEffect(() => {
    cam();
    colors();
    void props.scene;
    void props.quality;
    void props.layers.buildings;
    slices();
    standing();
    draw();
  });

  /** Sizes the canvas's pixels to the view and the quality; true when that changed them (and cleared the canvas). */
  const sizeCanvas = () => {
    const v = vp();
    if (!v.width || !v.height) return false;
    const most = gl ? Math.min(...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)) : 4096;
    const k = canvasScale(v, window.devicePixelRatio, props.quality === 'high', Math.min(8192, most));
    const width = Math.round(v.width * k);
    const height = Math.round(v.height * k);
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  };
  createEffect(() => {
    void props.quality;
    untrack(() => sizeCanvas() && drawNow());
  });

  onMount(() => {
    gl = webgl(canvas);
    if (!gl) setGlFailed(true);

    setColors(themeColors());
    const themes = new MutationObserver(() => setColors(themeColors()));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ab-theme', 'data-ab-style'] });

    const sizes = new ResizeObserver(() => {
      const v = { width: el.clientWidth, height: el.clientHeight };
      if (!v.width || !v.height) return;
      setVp(v);
      const c = untrack(cam);
      setCam(c ? clampCamera(c, v) : homeOf(v));
      sizeCanvas();
      drawNow(); // now: resizing cleared the canvas
    });
    sizes.observe(el);

    el.addEventListener('wheel', onWheel, { passive: false });
    onCleanup(() => {
      themes.disconnect();
      sizes.disconnect();
      el.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(drawFrame);
      terrainRenderer?.dispose();
      modelRenderer?.dispose();
      objectRenderer?.dispose();
      terrainRenderer = modelRenderer = objectRenderer = null;
      // Free the context now rather than when the canvas is collected (browsers allow only a few at once).
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      gl = null;
    });
  });

  // ---- following the selected hero: glide to it (zooming in), then keep it in the middle ----
  let followed: number | null = null;
  createEffect(() => {
    const id = props.follow ? props.selected : null;
    const xy = props.heroAt(id);
    const h = xy ? heroHeight(id, xy[0] * MAP_SIZE, xy[1] * MAP_SIZE) : 0;
    // Only the hero's moves drive this; the camera it moves must not.
    untrack(() => {
      const c = cam();
      if (id == null || !xy || !c) {
        followed = null;
        return;
      }
      // The camera looks at the map plane: aim it so that the hero, standing h up (on a roof, say), is in the middle.
      const { x, y } = anchored(c, vp(), vp().width / 2, vp().height / 2, [xy[0] * MAP_SIZE, xy[1] * MAP_SIZE], h);
      if (followed !== id) {
        followed = id;
        animateTo({ x, y, zoom: Math.max(c.zoom, 2.6) });
      } else if (!anim) {
        set({ ...c, x: c.x + (x - c.x) * 0.25, y: c.y + (y - c.y) * 0.25 });
      }
    });
  });

  // ---- pointer, wheel and keys ----
  const pointers = new Map<number, [number, number]>();
  type Gesture =
    | { kind: 'pan'; id: number; from: [number, number]; ground: [number, number] | null; moved: boolean }
    | { kind: 'turn'; id: number; from: [number, number]; yaw: number; tilt: number; moved: boolean }
    | { kind: 'pinch'; dist: number; angle: number; ground: [number, number] | null };
  let gesture: Gesture | null = null;
  let suppressClick = false;
  /** Wraps a click handler so the click that ends a drag is ignored. */
  const click = (f: () => void) => () => {
    if (!suppressClick) f();
  };
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const twoFingers = () => {
    const [a, b] = [...pointers.values()] as [[number, number], [number, number]];
    return {
      dist: Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])),
      angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number],
    };
  };
  const startPan = (id: number, at: [number, number], moved: boolean): Gesture => {
    const c = cam();
    return { kind: 'pan', id, from: at, ground: c && unproject(c, vp(), at[0], at[1], anchorHeight()), moved };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    const c = cam();
    if (!c) return;
    stopAnimation();
    const at = local(e);
    pointers.set(e.pointerId, at);
    if (pointers.size === 2) {
      const f = twoFingers();
      gesture = { kind: 'pinch', dist: f.dist, angle: f.angle, ground: unproject(c, vp(), f.mid[0], f.mid[1], anchorHeight()) };
      setHinted(true);
    } else if (pointers.size === 1) {
      gesture =
        e.button === 2 || e.ctrlKey || e.metaKey
          ? { kind: 'turn', id: e.pointerId, from: at, yaw: c.yaw, tilt: c.tilt, moved: false }
          : startPan(e.pointerId, at, false);
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const at = local(e);
    pointers.set(e.pointerId, at);
    const c = cam();
    if (!c) return;
    if (gesture.kind === 'pinch') {
      if (pointers.size < 2) return;
      const f = twoFingers();
      let next = clampCamera({ ...c, zoom: (c.zoom * f.dist) / gesture.dist, yaw: c.yaw - wrapAngle(f.angle - gesture.angle) }, vp());
      if (gesture.ground) next = anchored(next, vp(), f.mid[0], f.mid[1], gesture.ground, anchorHeight());
      set(next);
      gesture.dist = f.dist;
      gesture.angle = f.angle;
      return;
    }
    if (gesture.id !== e.pointerId) return;
    const dx = at[0] - gesture.from[0];
    const dy = at[1] - gesture.from[1];
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      gesture.moved = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone
      }
      setHinted(true);
    }
    if (gesture.kind === 'pan') {
      if (gesture.ground) set(anchored(c, vp(), at[0], at[1], gesture.ground, anchorHeight()));
    } else {
      // Dragging right turns the map like a turntable pushed at its near edge; dragging up tilts towards the horizon.
      set({ ...c, yaw: gesture.yaw + dx * TURN_PER_PX, tilt: gesture.tilt - dy * TILT_PER_PX });
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'pinch' || gesture.moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    if (gesture.kind === 'pinch') {
      // One finger left on the map: carry on panning with it.
      const rest = [...pointers.entries()][0];
      gesture = rest ? startPan(rest[0], rest[1], true) : null;
    } else if (gesture.id === e.pointerId) {
      gesture = null;
    }
  };
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const c = cam();
    if (!c) return;
    stopAnimation();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * vp().height : e.deltaY;
    const [x, y] = local(e);
    set(zoomAround(c, vp(), Math.exp(-Math.max(-400, Math.min(400, px)) * 0.0022), x, y, anchorHeight()));
    setHinted(true);
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const v = vp();
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(-0.2 * v.width, 0),
      ArrowRight: () => panBy(0.2 * v.width, 0),
      ArrowUp: () => panBy(0, -0.2 * v.height),
      ArrowDown: () => panBy(0, 0.2 * v.height),
      '+': () => zoomBy(STEP_ZOOM),
      '=': () => zoomBy(STEP_ZOOM),
      '-': () => zoomBy(1 / STEP_ZOOM),
      q: () => turnBy(STEP_TURN / 2),
      e: () => turnBy(-STEP_TURN / 2),
      PageUp: () => tiltBy(rad(8)),
      PageDown: () => tiltBy(rad(-8)),
      '0': home,
      Home: home,
    };
    const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!run) return;
    e.preventDefault();
    setHinted(true);
    run();
  };

  const atHome = () => {
    const c = cam();
    const h = homeOf(vp());
    return !!c && Math.abs(c.zoom - h.zoom) < 0.02 && Math.abs(wrapAngle(c.yaw)) < 0.01 && Math.abs(c.tilt - h.tilt) < 0.01 && Math.hypot(c.x - h.x, c.y - h.y) < 4;
  };
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const button = 'grid size-8 place-items-center text-sm text-ink-200 hover:bg-ink-800';

  return (
    <div
      ref={el}
      class="absolute inset-0 cursor-grab touch-none select-none focus-visible:outline-offset-[-3px] active:cursor-grabbing"
      tabindex="0"
      role="application"
      aria-roledescription="map"
      aria-label="Live map, 2.5D view. Arrow keys pan, plus and minus zoom, Q and E turn, Page Up and Page Down tilt, 0 shows the whole map."
      data-scene={props.scene}
      data-open-interiors={openings().length}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      onClick={click(() => props.onSelect(null))}
      onDblClick={home}
      onKeyDown={onKeyDown}
    >
      {/* Light from above the middle of the map, on the background around it. */}
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,color-mix(in_oklab,var(--color-ink-700)_45%,transparent),transparent_70%)]" />
      <canvas ref={canvas} class="absolute inset-0 size-full" classList={{ hidden: !!flatImage() }} />
      <Show when={flatImage() && cam() && vp().width ? flatImage() : null}>
        {(src) => (
          <img
            src={src()}
            alt=""
            draggable={false}
            class="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left opacity-55"
            style={{ width: `${MAP_SIZE}px`, height: `${MAP_SIZE}px`, transform: cssMatrix(cam()!, vp()) }}
          />
        )}
      </Show>

      <svg class="absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${vp().width || 1} ${vp().height || 1}`} aria-hidden="true">
        <defs>
          <clipPath id="hero-clip"><circle r="14" /></clipPath>
          <clipPath id="rounded" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.25" /></clipPath>
          <filter id="grey"><feColorMatrix type="saturate" values="0" /></filter>
          <radialGradient id="shadow-25d">
            <stop offset="0" stop-color="#000" stop-opacity="0.6" />
            <stop offset="1" stop-color="#000" stop-opacity="0" />
          </radialGradient>
          <For each={[['0', TEAM_COLOR[0]], ['1', TEAM_COLOR[1]], ['n', '#b07cff']] as const}>
            {([key, color]) => (
              <radialGradient id={`glow-25d-${key}`}>
                <stop offset="0" stop-color={color} stop-opacity="0.32" />
                <stop offset="1" stop-color={color} stop-opacity="0" />
              </radialGradient>
            )}
          </For>
        </defs>
        <Show when={proj()}>
          {(p) => (
            <>
              {/* Lanes: the ziplines, at their own heights in 3D, just above the raised roofs in 2.5D. */}
              <Show when={props.layers.lanes}>
                <For each={props.assets?.map.lanes ?? []}>
                  {(lane) => (
                    <polyline
                      points={lane.points
                        .map(([wx, wy, wz]) => {
                          const m = props.at(wx, wy);
                          const x = m[0] * MAP_SIZE;
                          const y = m[1] * MAP_SIZE;
                          const shown = shownModel();
                          const h = shown
                            ? wz != null
                              ? mapHeight(shown, wz)
                              : standAt(x, y) + LANE_LIFT // assets without zipline heights
                            : props.layers.buildings
                              ? BUILDING_HEIGHT + 3
                              : 0;
                          const s = p()(x, y, h);
                          return `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
                        })
                        .join(' ')}
                      fill="none"
                      stroke={lane.color}
                      stroke-width={2.6 * markerBase()}
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      opacity="0.55"
                    />
                  )}
                </For>
              </Show>

              {/* On the ground: team light around objectives, shadows, and the rings of the rift, the urn's pad and the selection. */}
              <Show when={props.layers.objectives}>
                <Index each={props.frame?.objectives ?? []}>
                  {(o) => (
                    <Show when={objectiveGround(o())}>
                      {(g) => (
                        <ellipse
                          cx={g().x}
                          cy={g().y}
                          rx={GLOW_RADIUS * g().scale}
                          ry={GLOW_RADIUS * g().scale * squash(g().depth)}
                          fill={`url(#glow-25d-${o().kind === 'midboss' || o().team == null ? 'n' : o().team})`}
                        />
                      )}
                    </Show>
                  )}
                </Index>
                <Index each={props.frame?.objectives ?? []}>
                  {(o) => (
                    <Show when={objectiveGround(o())}>
                      {(g) => <Shadow s={g()} r={9 * scaleAt(g().depth)} squash={squash(g().depth)} />}
                    </Show>
                  )}
                </Index>
                <Show when={props.frame?.rift}>
                  {(r) => (
                    <Show when={ground(r().x, r().y, r().z)}>
                      {(g) => (
                        <ellipse
                          cx={g().x}
                          cy={g().y}
                          rx={30 * g().scale}
                          ry={30 * g().scale * squash(g().depth)}
                          fill="rgb(79 209 197 / 0.08)"
                          stroke={r().open && r().contested ? 'var(--color-warn)' : RIFT_COLOR}
                          stroke-width={2 * markerBase()}
                          stroke-dasharray={r().open ? undefined : `${6 * markerBase()} ${5 * markerBase()}`}
                          class={r().open && r().contested ? 'animate-pulse-soft' : undefined}
                        />
                      )}
                    </Show>
                  )}
                </Show>
                <Show when={props.frame?.urn?.delivery}>
                  {(d) => (
                    <Show when={ground(d()[0], d()[1], props.frame?.urn?.delivery_z)}>
                      {(g) => (
                        <g transform={`translate(${g().x.toFixed(1)} ${g().y.toFixed(1)}) scale(1 ${squash(g().depth).toFixed(3)})`}>
                          <MapScale.Provider value={() => scaleAt(g().depth)}>
                            <UrnDelivery at={ORIGIN} color={props.carrierTeam == null ? URN_COLOR : TEAM_COLOR[props.carrierTeam]} />
                          </MapScale.Provider>
                        </g>
                      )}
                    </Show>
                  )}
                </Show>
              </Show>
              <Index each={players()}>
                {(pl) => (
                  <Show when={pl().alive && heroGround(pl().account_id)}>
                    {(g) => <Shadow s={g()} r={13 * scaleAt(g().depth)} squash={squash(g().depth)} />}
                  </Show>
                )}
              </Index>
              <Show when={heroGround(props.selected)}>
                {(g) => (
                  <ellipse
                    cx={g().x}
                    cy={g().y}
                    rx={24 * scaleAt(g().depth)}
                    ry={24 * scaleAt(g().depth) * squash(g().depth)}
                    fill="none"
                    stroke="var(--color-gold-400)"
                    stroke-width={2 * markerBase()}
                    stroke-dasharray={`${5 * markerBase()} ${4 * markerBase()}`}
                  />
                )}
              </Show>

              {/* Standing up, far to near: camps, objectives (on a pillar showing their health), the rest, heroes. */}
              <Show when={props.layers.camps}>
                <For each={campOrder()}>
                  {(id) => (
                    <Show when={campById().get(id)}>
                      {(c) => (
                        <Show when={ground(c().x, c().y, c().z)}>
                          {(g) => (
                            <Stand s={g()} lift={rise(CAMP_LIFT, scaleAt(g().depth))} k={scaleAt(g().depth)}>
                              <CampMarker camp={c()} kind={props.campKind(c())} sinner={props.sinnerAt(c().x, c().y)} at={ORIGIN} />
                            </Stand>
                          )}
                        </Show>
                      )}
                    </Show>
                  )}
                </For>
              </Show>
              <Show when={props.layers.objectives}>
                <For each={objectiveOrder()}>
                  {(id) => (
                    <Show when={objectiveById().get(id)}>
                      {(o) => (
                        <Show when={objectiveGround(o())}>
                          {(g) => {
                            const k = () => scaleAt(g().depth);
                            // Over its model the marker stands clear of the model's head (the icon is upright, centred
                            // on the end of its stem): the model shows where it is.
                            const top = () => topOf(objectiveKey(o().id));
                            const base = () => top() ?? g();
                            const up = () =>
                              top()
                                ? ((OBJECTIVE_SIZE[o().kind] ?? 10) + 6) * k() + rise(MODEL_LIFT, k())
                                : rise(OBJECTIVE_LIFT[o().kind] ?? 30, k());
                            const share = () => (o().max_hp > 0 ? Math.max(0, Math.min(1, o().hp / o().max_hp)) : 1);
                            return (
                              <>
                                <Show when={up() > 2}>
                                  <rect x={base().x - 2.6 * k()} y={base().y - up()} width={5.2 * k()} height={up()} rx={1.6 * k()} fill="#0b0a10" opacity="0.85" />
                                  <rect
                                    x={base().x - 1.5 * k()}
                                    y={base().y - up() * share()}
                                    width={3 * k()}
                                    height={up() * share()}
                                    rx={k()}
                                    fill={objectiveColor(o().kind, o().team)}
                                    opacity="0.9"
                                  />
                                </Show>
                                <Stand s={base()} lift={up()} k={k()}>
                                  <ObjectiveMarker o={o()} at={ORIGIN} />
                                </Stand>
                              </>
                            );
                          }}
                        </Show>
                      )}
                    </Show>
                  )}
                </For>
                <Show when={!midbossAlive() && props.frame?.midboss_respawn_in_s}>
                  {(left) => (
                    <Show when={ground(0, 0, props.frame?.midboss_z)}>
                      {(g) => (
                        <Stand s={g()} lift={rise(14, scaleAt(g().depth))} k={scaleAt(g().depth)}>
                          <MidbossTimer left={left()} at={ORIGIN} />
                        </Stand>
                      )}
                    </Show>
                  )}
                </Show>
                <Index each={props.frame?.powerups ?? []}>
                  {(pw) => {
                    // Over its crystal when that is shown; on the bridge (its spawner's height) otherwise.
                    const top = () => topOf(powerupKey(pw().x, pw().y));
                    return (
                      <Show when={top() ?? ground(pw().x, pw().y, zOf('powerup', pw().x, pw().y, pw().z))}>
                        {(g) => {
                          const k = () => scaleAt(g().depth);
                          return (
                            <Stand s={g()} lift={top() ? POWERUP_HALF * k() + rise(6, k()) : rise(10, k())} k={k()}>
                              <PowerupMarker at={ORIGIN} kind={pw().kind} />
                            </Stand>
                          );
                        }}
                      </Show>
                    );
                  }}
                </Index>
                <Show when={props.frame?.rift}>
                  {(r) => (
                    <Show when={ground(r().x, r().y, r().z)}>
                      {(g) => (
                        <Stand s={g()} lift={rise(18, scaleAt(g().depth))} k={scaleAt(g().depth)}>
                          <RiftMarker r={r()} at={ORIGIN} />
                        </Stand>
                      )}
                    </Show>
                  )}
                </Show>
                <Show when={props.frame?.urn?.carrier == null && props.frame?.urn}>
                  {(u) => (
                    <Show when={ground(u().x, u().y, u().z)}>
                      {(g) => (
                        <>
                          <Shadow s={g()} r={11 * scaleAt(g().depth)} squash={squash(g().depth)} />
                          <Stand s={g()} lift={rise(14, scaleAt(g().depth))} k={scaleAt(g().depth)}>
                            <UrnMarker at={ORIGIN} value={u().value} />
                          </Stand>
                        </>
                      )}
                    </Show>
                  )}
                </Show>
              </Show>
              <For each={heroOrder()}>
                {(id) => (
                  <Show when={playerById().get(id)}>
                    {(pl) => (
                      <Show when={heroGround(id)}>
                        {(g) => {
                          const k = () => scaleAt(g().depth);
                          const up = () => (pl().alive ? rise(HERO_LIFT, k()) : 0);
                          return (
                            <>
                              <Show when={up() > 2}>
                                <line
                                  x1={g().x}
                                  y1={g().y}
                                  x2={g().x}
                                  y2={g().y - up()}
                                  stroke={TEAM_COLOR[pl().team]}
                                  stroke-width={2.4 * k()}
                                  stroke-linecap="round"
                                  opacity="0.9"
                                />
                              </Show>
                              <Stand s={g()} lift={up()} k={k()}>
                                <HeroMarker
                                  p={pl()}
                                  at={ORIGIN}
                                  assets={props.assets}
                                  selected={props.selected === id}
                                  label={props.label(id)}
                                  showName={props.layers.names}
                                  onSelect={click(() => props.onSelect(id))}
                                />
                              </Stand>
                            </>
                          );
                        }}
                      </Show>
                    )}
                  </Show>
                )}
              </For>
              <Show when={props.layers.objectives && heroGround(urnCarrier())}>
                {(g) => (
                  <Stand s={g()} lift={rise(HERO_LIFT, scaleAt(g().depth))} k={scaleAt(g().depth)}>
                    <UrnCarried at={ORIGIN} />
                  </Stand>
                )}
              </Show>
            </>
          )}
        </Show>
      </svg>

      <Show when={props.scene === 'model' && !glFailed() && ((model().state === 'loading' && !model().data) || model().state === 'failed')}>
        <p class="pointer-events-none absolute inset-x-0 top-1/2 mx-auto w-fit max-w-[80%] -translate-y-1/2 rounded-lg bg-ink-950/85 px-3 py-1.5 text-center text-xs text-ink-300">
          {model().state === 'loading' ? 'Loading the 3D map…' : "The 3D map couldn't be loaded, so this is the flat minimap."}
        </p>
      </Show>
      {/* Switching quality: the map shown stays until the other one is here. */}
      <Show when={props.scene === 'model' && !glFailed() && model().state === 'loading' && model().data}>
        <p class="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-lg bg-ink-950/80 px-2.5 py-1 text-center text-[11px] text-ink-300">
          {props.quality === 'high' ? 'Loading the detailed map…' : 'Loading the map…'}
        </p>
      </Show>
      <Show when={!hinted()}>
        <p class="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[70%] rounded-lg bg-ink-950/80 px-2.5 py-1 text-center text-[11px] text-ink-300">
          {touch ? 'Drag to move · pinch to zoom · twist to turn' : 'Drag to move · scroll to zoom · right-drag to turn and tilt'}
        </p>
      </Show>

      {/* Turn above, zoom below, as in map apps. */}
      <div
        class="absolute bottom-3 right-3 flex cursor-default flex-col items-end gap-1.5"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
      >
        <div class="flex overflow-hidden rounded-lg bg-ink-950/85 ring-1 ring-ink-700">
          <button class={button} title="Turn the map anticlockwise (Q)" aria-label="Turn the map anticlockwise" onClick={() => turnBy(STEP_TURN)}>⟲</button>
          <button class={button} title="North up" aria-label="North up" onClick={() => animateTo({ yaw: 0 })}>
            <svg viewBox="-10 -10 20 20" class="size-4" style={{ transform: `rotate(${-(cam()?.yaw ?? 0)}rad)` }} aria-hidden="true">
              <path d="M0 -8 L3.6 1 L-3.6 1 Z" fill="var(--color-loss)" />
              <path d="M0 8 L3.6 1 L-3.6 1 Z" fill="var(--color-ink-300)" />
            </svg>
          </button>
          <button class={button} title="Turn the map clockwise (E)" aria-label="Turn the map clockwise" onClick={() => turnBy(-STEP_TURN)}>⟳</button>
        </div>
        <div class="flex flex-col overflow-hidden rounded-lg bg-ink-950/85 ring-1 ring-ink-700">
          <button class={button} title="Zoom in (or scroll)" aria-label="Zoom in" onClick={() => zoomBy(STEP_ZOOM)}>+</button>
          <button class={button} title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / STEP_ZOOM)}>−</button>
          <Show when={!atHome()}>
            <button class={`${button} text-xs text-ink-300`} title="Whole map (or double-click)" aria-label="Whole map" onClick={home}>⤢</button>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** A soft round shadow on the ground. */
function Shadow(props: { s: ScreenPoint; r: number; squash: number }) {
  return <ellipse cx={props.s.x} cy={props.s.y} rx={props.r} ry={props.r * props.squash} fill="url(#shadow-25d)" />;
}
