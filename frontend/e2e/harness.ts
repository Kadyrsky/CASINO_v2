/**
 * The page the renderer tests (renderers.spec.ts) drive: the realtime map's WebGL renderers on canvases of their own,
 * drawing scenes made up here or the map files the site ships, read back pixel by pixel (gl.readPixels right after a
 * draw, before the browser shows it). Each function returns plain data for the test to check.
 */
import { DEFAULT_TILT, DISTANCE, clipMatrix, projector, type Camera, type Viewport } from '../src/lib/mapCamera';
import { InteriorIndex, OPEN_RADIUS, SLICE } from '../src/lib/mapInteriors';
import { loadModel, mapHeight, type MapModel } from '../src/lib/mapModel';
import { ModelRenderer } from '../src/lib/mapModelRenderer';
import { ObjectRenderer } from '../src/lib/mapObjectRenderer';
import { loadObjects, modelFor } from '../src/lib/mapObjects';
import { TerrainRenderer, webgl, type TerrainColors } from '../src/lib/mapRenderer';
import { loadTerrain } from '../src/lib/mapTerrain';

type Rgb = [number, number, number];
type Pixel = [number, number, number, number];

function surface(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`; // the renderers size their rims in CSS pixels
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  const gl = webgl(canvas);
  if (!gl) throw new Error('no WebGL');
  const vp: Viewport = { width, height };
  return { canvas, gl, vp };
}

/** The canvas as RGBA, rows from the top as on the screen. */
function read(gl: WebGLRenderingContext): { width: number; height: number; px: Uint8Array } {
  const { drawingBufferWidth: width, drawingBufferHeight: height } = gl;
  const raw = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const px = new Uint8Array(raw.length);
  for (let y = 0; y < height; y++) px.set(raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
  return { width, height, px };
}

function pixel({ width, px }: ReturnType<typeof read>, x: number, y: number): Pixel {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
}

/** Share of the pixels in a box (screen pixels, clipped to the canvas) that differ between two reads. */
function changed(a: ReturnType<typeof read>, b: ReturnType<typeof read>, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  let diff = 0;
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(a.height, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(a.width, Math.round(x1)); x++) {
      const p = pixel(a, x, y);
      const q = pixel(b, x, y);
      n++;
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) + Math.abs(p[3] - q[3]) > 24) diff++;
    }
  }
  return n ? diff / n : 0;
}

/** A model of the map made of square floors (map units: x0, y0, x1, y1, height, colour), the interiors' given. */
function scene(squares: [number, number, number, number, number, Rgb][], interiors: [number, number, number, number, number][]): MapModel {
  const quads = (list: [number, number, number, number, number][]) => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [x0, y0, x1, y1, h] of list) {
      const k = positions.length / 3;
      positions.push(x0, y0, h, x1, y0, h, x1, y1, h, x0, y1, h);
      // Facing up: map space's y runs down, so the renderer's normal is the negated cross product.
      indices.push(k, k + 2, k + 1, k, k + 3, k + 2);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  };
  const floors = quads(squares.map(([x0, y0, x1, y1, h]) => [x0, y0, x1, y1, h]));
  const inner = quads(interiors);
  return {
    radius: 10752,
    ...floors,
    colors: new Uint8Array(squares.flatMap(([, , , , , rgb]) => [...rgb, ...rgb])),
    ground: new Float32Array([0]),
    groundSize: 1,
    arena: null,
    interiors: { ...inner, regions: new Uint16Array(inner.indices.length / 3) },
  };
}

/** What a pixel of the made-up scene shows. */
function kind([r, g, b, a]: Pixel): string {
  if (a < 200) return 'nothing';
  if (Math.min(r, g, b) > 150) return 'rim';
  if (r > b + 25) return 'floor';
  if (b > r + 25) return 'roof';
  return 'other';
}

const THEME: TerrainColors = {
  street: [0.11, 0.1, 0.16],
  streetShade: [0.04, 0.04, 0.06],
  wall: [0.36, 0.33, 0.45],
  roof: [0.23, 0.21, 0.31],
  roofEdge: [0.54, 0.51, 0.64],
  edge: [0.16, 0.15, 0.22],
};

const harness = {
  /** Which of the renderers' WebGL programs this browser built. */
  programs() {
    const { canvas, gl } = surface(64, 64);
    const model = ModelRenderer.create(canvas, gl) as unknown as Record<string, unknown> | null;
    return {
      model: !!model?.program,
      shadows: !!model?.shadowProgram,
      shadowDepth: !!model?.depthProgram,
      slices: !!model?.sliceProgram,
      objects: !!ObjectRenderer.create(gl),
      terrain: !!TerrainRenderer.create(canvas, gl),
    };
  },

  /**
   * A red floor with a blue roof 30 map units over its middle (200 across), the floor an interior. Looking straight
   * down, along a line from the middle: what each pixel shows with no interior open, with a hero in the interior (its
   * slice opens the floor within the opening radius), and closed again.
   */
  cut(shadows: boolean) {
    const size = 400;
    const { canvas, gl, vp } = surface(size, size);
    const model = scene(
      [
        [300, 300, 700, 700, 0, [200, 40, 40]],
        [400, 400, 600, 600, 30, [40, 40, 200]],
      ],
      [[400, 400, 600, 600, 0]],
    );
    const renderer = ModelRenderer.create(canvas, gl)!;
    renderer.setModel(model);
    renderer.setShadows(shadows);
    const cam: Camera = { x: 500, y: 500, zoom: 3, yaw: 0, tilt: 0 };
    const matrix = clipMatrix(cam, vp);
    const project = projector(cam, vp);
    const middle = project(500, 500, 30);
    const roofEnd = project(600, 500, 30).x - middle.x;
    const line = () => {
      const image = read(gl);
      return Array.from({ length: Math.floor(roofEnd * 0.9) }, (_, i) => kind(pixel(image, middle.x + i, middle.y)));
    };
    renderer.draw(matrix);
    const closed = line();
    const index = InteriorIndex.of(model)!;
    renderer.setSlices(index.slices([{ x: 500, y: 500, floor: 0, region: 0 }]));
    renderer.draw(matrix);
    const open = line();
    renderer.setSlices(null);
    renderer.draw(matrix);
    const closedAgain = line();
    // Where the opening's edge crosses the roof, in pixels from the middle: rays from the camera (DISTANCE straight
    // above) through the roof meet the slice's circle there.
    const radius = mapHeight(model, OPEN_RADIUS);
    const slice = mapHeight(model, SLICE);
    const edge = project(500 + (radius * (DISTANCE - 30)) / (DISTANCE - slice), 500, 30).x - middle.x;
    return { closed, open, closedAgain, edge, error: gl.getError() };
  },

  /**
   * The real map, looking at a hero standing at world point `at` (as frames have it), with and without its interior
   * open: how much changes round the hero and far from it, and whether closing it again draws what was there.
   */
  async opening(at: [number, number, number], url = '/maps/dl_midtown.bin.gz') {
    const model = await loadModel(url);
    const R = model.radius;
    const x = ((at[0] + R) / (2 * R)) * 1000;
    const y = ((R - at[1]) / (2 * R)) * 1000;
    const index = InteriorIndex.of(model)!;
    const footing = index.footing(x, y, mapHeight(model, at[2]));
    if (!footing) return { footing: null };
    const { canvas, gl, vp } = surface(600, 450);
    const renderer = ModelRenderer.create(canvas, gl)!;
    renderer.setModel(model);
    const cam: Camera = { x, y, zoom: 4, yaw: 0, tilt: DEFAULT_TILT };
    const matrix = clipMatrix(cam, vp);
    const hero = projector(cam, vp)(x, y, footing.floor);
    renderer.draw(matrix);
    const closed = read(gl);
    renderer.setSlices(index.slices([{ x, y, ...footing }]));
    renderer.draw(matrix);
    const open = read(gl);
    renderer.setSlices(null);
    renderer.draw(matrix);
    const closedAgain = read(gl);
    return {
      footing,
      hero: [hero.x, hero.y],
      near: changed(closed, open, hero.x - 40, hero.y - 40, hero.x + 40, hero.y + 40),
      far: Math.max(changed(closed, open, 0, 0, 40, 40), changed(closed, open, 560, 0, 600, 40), changed(closed, open, 0, 410, 40, 450)),
      again: changed(closed, closedAgain, 0, 0, 600, 450),
      drawn: changed(closed, { ...closed, px: new Uint8Array(closed.px.length) }, 0, 0, 600, 450),
      error: gl.getError(),
    };
  },

  /**
   * Each team's guardian, walker, base guardian, shrine and patron and a power-up crystal of each kind on an empty
   * canvas: how much of it each covers.
   */
  async objects() {
    const objects = await loadObjects('/maps/objects.bin.gz');
    const { gl, vp } = surface(300, 300);
    const renderer = ObjectRenderer.create(gl)!;
    const cam: Camera = { x: 500, y: 500, zoom: 6, yaw: 0, tilt: DEFAULT_TILT };
    const matrix = clipMatrix(cam, vp);
    const cover = (kind: 'walker' | 'guardian' | 'base_guardian' | 'shrine' | 'patron' | 'powerup', team: 0 | 1 | null, skin?: string) => {
      const look = modelFor(objects, kind, team, skin);
      if (!look) return -1;
      gl.viewport(0, 0, 300, 300);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      renderer.draw(matrix, [{ ...look, x: 500, y: 500, h: 0, yaw: 90 }], 10752, kind === 'powerup' ? 6 : 1);
      const image = read(gl);
      let n = 0;
      for (let i = 3; i < image.px.length; i += 4) if (image.px[i]! > 0) n++;
      return n / (300 * 300);
    };
    return {
      walker: [cover('walker', 0), cover('walker', 1)],
      guardian: [cover('guardian', 0), cover('guardian', 1)],
      baseGuardian: [cover('base_guardian', 0), cover('base_guardian', 1)],
      shrine: [cover('shrine', 0), cover('shrine', 1)],
      patron: [cover('patron', 0), cover('patron', 1)],
      powerup: ['gun', 'survival', 'casting', 'movement'].map((k) => cover('powerup', null, k)),
      error: gl.getError(),
    };
  },

  /**
   * The 2.5D view's terrain, traced from a made-up minimap (a round map of streets with square buildings in it):
   * how many walls it found, and how much of the canvas the map covers with the buildings raised and laid flat.
   */
  async terrain() {
    const side = 256;
    const art = document.createElement('canvas');
    art.width = art.height = side;
    const g = art.getContext('2d')!;
    g.fillStyle = 'rgba(20, 18, 30, 0.7)'; // streets: dark, half see-through
    g.beginPath();
    g.arc(side / 2, side / 2, side * 0.45, 0, 2 * Math.PI);
    g.fill();
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) g.clearRect(60 + i * 36, 60 + j * 36, 20, 20); // buildings
    const terrain = await loadTerrain(art.toDataURL('image/png'));
    const { canvas, gl, vp } = surface(400, 300);
    const renderer = TerrainRenderer.create(canvas, gl)!;
    renderer.setTerrain(terrain);
    const cam: Camera = { x: 500, y: 500, zoom: 1, yaw: 0, tilt: DEFAULT_TILT };
    const matrix = clipMatrix(cam, vp);
    renderer.draw(matrix, THEME, true);
    const raised = read(gl);
    renderer.draw(matrix, THEME, false);
    const flat = read(gl);
    const empty = { ...raised, px: new Uint8Array(raised.px.length) };
    return {
      walls: terrain.walls.length / 4,
      drawn: changed(raised, empty, 0, 0, 400, 300),
      buildings: changed(raised, flat, 0, 0, 400, 300),
      error: gl.getError(),
    };
  },
};

export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}
window.harness = harness;
document.title = 'ready';
