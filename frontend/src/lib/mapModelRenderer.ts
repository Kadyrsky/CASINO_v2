/**
 * Draws the 3D view's model of the map (see mapModel.ts) with WebGL: flat-shaded triangles in the game's colours,
 * lit by a low sun from the south-west and the sky, with a little shade near the streets. With shadows on (the High
 * quality setting) the sun casts them: a shadow map, rendered once per model since neither the sun nor the map moves.
 * Interiors with heroes in them are cut open (see mapInteriors.ts): their slices are drawn first into a depth map from
 * the camera, and the model then leaves out what is nearer than a slice. Shares the canvas's context with the terrain
 * renderer.
 */
import { MAP_SIZE } from './mapCamera';
import { SLICE_STRIDE } from './mapInteriors';
import type { MapModel } from './mapModel';
import { buildProgram } from './mapRenderer';

/** How far (map units) shadow lookups start from a surface, along its normal, so it doesn't shadow itself. */
const SHADOW_OFFSET = 0.6;

const VERTEX = `
attribute vec3 a_pos;
attribute vec3 a_normal;
attribute vec3 a_color;
uniform mat4 u_matrix;
varying vec3 v_normal;
varying vec3 v_color;
varying vec2 v_xy;
varying float v_h;
#ifdef SHADOWS
uniform mat4 u_light;
varying vec3 v_shadow;
#endif
void main() {
  v_normal = a_normal;
  v_color = a_color;
  v_xy = a_pos.xy;
  v_h = a_pos.z;
#ifdef SHADOWS
  // Where this point is in the shadow map: x and y on it, and the depth there, all 0 to 1.
  v_shadow = (u_light * vec4(a_pos + a_normal * ${SHADOW_OFFSET.toFixed(2)}, 1.0)).xyz * 0.5 + 0.5;
#endif
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

/** A depth (0 to 1) in four bytes, and back: the shadow map's and the slice map's texels. */
const PACK = `
vec4 pack(float depth) {
  vec4 bytes = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * depth);
  return bytes - bytes.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
float unpack(vec4 bytes) {
  return dot(bytes, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}`;

// Depths are compared to a few millionths: high precision where the GPU has it (every desktop one).
const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif`;

// Lighting in linear light: the colours are sRGB averages of the game's textures.
const FRAGMENT = `
${PRECISION}
uniform vec3 u_sun;
uniform vec3 u_sunColor;
uniform vec3 u_sky;
uniform vec3 u_bounce;
uniform float u_street;
varying vec3 v_normal;
varying vec3 v_color;
varying vec2 v_xy;
varying float v_h;
${PACK}
// The open interiors' slices: at each pixel, the depth of the nearest slice (0 where there is none).
uniform sampler2D u_slices;
uniform vec2 u_pixel; // 1 / the canvas's size; 0 while no interior is open
uniform vec4 u_box; // where on the canvas the slices are, rims included (pixels: x and y from, x and y to)
uniform float u_rim; // the rim round an opening, in pixels
float sliceAt(vec2 frag) {
  return unpack(texture2D(u_slices, frag * u_pixel));
}
// Whether a pixel nearby cuts this point away: then it is the edge of what was cut, drawn as a rim.
bool onRim() {
  vec2 p = gl_FragCoord.xy;
  float z = gl_FragCoord.z;
  vec4 s = vec4(sliceAt(p + vec2(u_rim, 0.0)), sliceAt(p - vec2(u_rim, 0.0)), sliceAt(p + vec2(0.0, u_rim)), sliceAt(p - vec2(0.0, u_rim)));
  // A slice there (above 0) that this point is in front of.
  return dot(step(vec4(1e-7), s) * step(vec4(z), s), vec4(1.0)) > 0.0;
}
#ifdef SHADOWS
uniform sampler2D u_shadowMap;
uniform float u_texel;
varying vec3 v_shadow;
float depthAt(vec2 uv) {
  return unpack(texture2D(u_shadowMap, uv));
}
// The share of the sun that reaches this point: nine lookups around it, for soft edges.
float sunlight() {
  float lit = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      lit += step(v_shadow.z - 0.0004, depthAt(v_shadow.xy + vec2(float(i), float(j)) * u_texel));
    }
  }
  return lit / 9.0;
}
#endif
void main() {
  // Between the camera and an open interior's slice: left out, so the interior shows.
  bool near = u_pixel.x > 0.0 && all(greaterThanEqual(gl_FragCoord.xy, u_box.xy)) && all(lessThanEqual(gl_FragCoord.xy, u_box.zw));
  float slice = near ? sliceAt(gl_FragCoord.xy) : 0.0;
  if (gl_FragCoord.z < slice) discard;
  bool inside = slice > 0.0;
  bool rim = near && !inside && onRim();
  vec3 n = normalize(v_normal);
  vec3 albedo = pow(v_color, vec3(2.2));
  // Texture averages are greyer than the textures look: give them back a little colour.
  albedo = max(mix(vec3(dot(albedo, vec3(0.2126, 0.7152, 0.0722))), albedo, 1.3), 0.0);
  vec3 ambient = mix(u_bounce, u_sky, n.z * 0.5 + 0.5);
  float sun = max(dot(n, u_sun), 0.0);
#ifdef SHADOWS
  // Inside an open interior the cover's shadow would leave everything black: lit as if the cover were gone.
  if (sun > 0.0 && !inside) sun *= sunlight();
#endif
  vec3 light = ambient + u_sunColor * sun;
  // An open interior is darker, so the opening reads as a pit.
  if (inside) light *= 0.55;
  float shade = mix(0.72, 1.0, clamp((v_h - u_street) / 40.0, 0.0, 1.0));
  vec3 color = pow(albedo * light * shade, vec3(1.0 / 2.2));
  // The cut edge, light like fresh stone, so the opening reads as cut out of the map.
  if (rim) color = mix(color, vec3(0.94, 0.87, 0.72), 0.8);
  gl_FragColor = vec4(color, 1.0);
}`;

/** The shadow map's pass: each texel holds the depth (as seen from the sun) of what the sun hits first, in 4 bytes. */
const DEPTH_VERTEX = `
attribute vec3 a_pos;
uniform mat4 u_light;
void main() {
  gl_Position = u_light * vec4(a_pos, 1.0);
}`;

const DEPTH_FRAGMENT = `
${PRECISION}
${PACK}
void main() {
  gl_FragColor = pack(gl_FragCoord.z);
}`;

/**
 * The slices' pass: the open interiors' floors raised to their slice (mapInteriors.ts), drawn from the camera into a
 * texture the size of the canvas, each texel the depth of the nearest slice there. A slice reaches as far around its
 * hero as its vertices say.
 */
const SLICE_VERTEX = `
attribute vec3 a_pos;
attribute vec3 a_round;
uniform mat4 u_matrix;
varying vec2 v_xy;
varying vec3 v_round;
void main() {
  v_xy = a_pos.xy;
  v_round = a_round;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

const SLICE_FRAGMENT = `
${PRECISION}
${PACK}
varying vec2 v_xy;
varying vec3 v_round;
void main() {
  if (distance(v_xy, v_round.xy) > v_round.z) discard;
  gl_FragColor = pack(gl_FragCoord.z);
}`;

/** Map space: x east, y south (down on the map), height up. The sun stands in the south-west, 50° up. */
export const SUN = normalize([-0.45, 0.55, 1.0]);

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

/**
 * Column-major 4×4 matrix from map space to the shadow map's clip space: an orthographic view along the sunlight
 * that just holds the whole map, from height `low` to `high` (map units). Depth grows away from the sun.
 */
export function sunMatrix(low: number, high: number, sun: [number, number, number] = SUN): Float32Array {
  const ray = normalize([-sun[0], -sun[1], -sun[2]]);
  const right = normalize(cross(ray, [0, 0, 1]));
  const up = cross(right, ray);
  const axes = [right, up, ray];
  const m = new Float32Array(16);
  axes.forEach((axis, row) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of [0, MAP_SIZE]) {
      for (const y of [0, MAP_SIZE]) {
        for (const h of [low, high]) {
          const d = axis[0] * x + axis[1] * y + axis[2] * h;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
    }
    const k = 2 / Math.max(hi - lo, 1e-6);
    for (let c = 0; c < 3; c++) m[c * 4 + row] = axis[c]! * k;
    m[12 + row] = -((lo + hi) / 2) * k;
  });
  m[15] = 1;
  return m;
}

/** Bytes per vertex: position (3 floats), normal (3 signed bytes + pad), colour (3 bytes + pad). */
const STRIDE = 20;

/**
 * One vertex per triangle corner, so each triangle has its own normal and colour (WebGL 1 has no flat shading).
 * The y flip from the game's axes to the map's mirrors the triangles, so the normal is the negated cross product.
 */
export function modelVertices(model: MapModel): ArrayBuffer {
  const { positions: P, indices: I, colors: C } = model;
  const n = I.length / 3;
  const buf = new ArrayBuffer(n * 3 * STRIDE);
  const f32 = new Float32Array(buf);
  const i8 = new Int8Array(buf);
  const u8 = new Uint8Array(buf);
  for (let t = 0; t < n; t++) {
    const a = I[t * 3]! * 3;
    const b = I[t * 3 + 1]! * 3;
    const c = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!;
    const uy = P[b + 1]! - P[a + 1]!;
    const uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!;
    const vy = P[c + 1]! - P[a + 1]!;
    const vz = P[c + 2]! - P[a + 2]!;
    let nx = -(uy * vz - uz * vy);
    let ny = -(uz * vx - ux * vz);
    let nz = -(ux * vy - uy * vx);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const [k, v] of [a, b, c].entries()) {
      const o = (t * 3 + k) * STRIDE;
      f32[o / 4] = P[v]!;
      f32[o / 4 + 1] = P[v + 1]!;
      f32[o / 4 + 2] = P[v + 2]!;
      i8[o + 12] = Math.round(nx * 127);
      i8[o + 13] = Math.round(ny * 127);
      i8[o + 14] = Math.round(nz * 127);
      u8[o + 16] = C[t * 3]!;
      u8[o + 17] = C[t * 3 + 1]!;
      u8[o + 18] = C[t * 3 + 2]!;
    }
  }
  return buf;
}

/**
 * The box on a width × height canvas that slice triangles (SLICE_STRIDE floats a vertex) cover through `matrix`, in
 * pixels counted from the bottom left as gl_FragCoord counts them: x and y from, x and y to.
 */
export function sliceBox(data: Float32Array, matrix: Float32Array, width: number, height: number): [number, number, number, number] {
  const m = matrix;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += SLICE_STRIDE) {
    const [x, y, z] = [data[i]!, data[i + 1]!, data[i + 2]!];
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return [0, 0, width, height]; // behind the camera (this camera never has that): anywhere
    const px = (((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w) * 0.5 + 0.5) * width;
    const py = (((m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) * 0.5 + 0.5) * height;
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  return [x0, y0, x1, y1];
}

/** The lowest and highest point of the model, in map units. */
function heightRange(model: MapModel): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const P = model.positions;
  for (let i = 2; i < P.length; i += 3) {
    lo = Math.min(lo, P[i]!);
    hi = Math.max(hi, P[i]!);
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

export class ModelRenderer {
  private program: WebGLProgram | null = null;
  private shadowProgram: WebGLProgram | null = null;
  private depthProgram: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private count = 0;
  private model: MapModel | null = null;
  private street = 0;
  private shadows = false;
  private shadowMap: WebGLTexture | null = null;
  private shadowSize = 0;
  private light: Float32Array | null = null;
  private sliceProgram: WebGLProgram | null = null;
  private sliceBuffer: WebGLBuffer | null = null;
  /** The open interiors' slice triangles (mapInteriors.ts), as last given, and their vertex count. */
  private sliceData: Float32Array | null = null;
  private sliceCount = 0;
  /** The slices' depth map from the camera, the canvas's size: a texture and the framebuffer that draws into it. */
  private sliceMap: { texture: WebGLTexture; depth: WebGLRenderbuffer; fb: WebGLFramebuffer; width: number; height: number } | null = null;
  /** Where on the canvas the slices were last drawn (pixels: x and y from, x and y to). */
  private sliceBox: [number, number, number, number] = [0, 0, 0, 0];
  private lost = false;
  private readonly onLost = (e: Event) => {
    e.preventDefault(); // allows the context to be restored
    this.lost = true;
  };
  private readonly onRestored = () => {
    this.lost = false;
    this.init();
    this.upload();
    this.restored?.();
  };

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
    private readonly restored?: () => void,
  ) {
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.init();
  }

  /** A renderer on the canvas's shared WebGL context, or null when its shaders can't be built. */
  static create(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, restored?: () => void): ModelRenderer | null {
    try {
      return new ModelRenderer(canvas, gl, restored);
    } catch {
      return null;
    }
  }

  private init() {
    this.program = buildProgram(this.gl, VERTEX, FRAGMENT, ['a_pos', 'a_normal', 'a_color']);
    this.buffer = this.gl.createBuffer();
    this.count = 0;
    // Shadows are optional: without these programs the model is drawn without them.
    try {
      const shadows = '#define SHADOWS\n';
      this.shadowProgram = buildProgram(this.gl, shadows + VERTEX, shadows + FRAGMENT, ['a_pos', 'a_normal', 'a_color']);
      this.depthProgram = buildProgram(this.gl, DEPTH_VERTEX, DEPTH_FRAGMENT, ['a_pos']);
    } catch {
      this.shadowProgram = this.depthProgram = null;
    }
    this.shadowMap = null;
    // Opening interiors is optional too: without it they stay covered.
    try {
      this.sliceProgram = buildProgram(this.gl, SLICE_VERTEX, SLICE_FRAGMENT, ['a_pos', 'a_round']);
      this.sliceBuffer = this.gl.createBuffer();
    } catch {
      this.sliceProgram = this.sliceBuffer = null;
    }
    this.sliceMap = null;
    this.sliceCount = 0;
    if (this.sliceData) this.setSlices(this.sliceData, true);
  }

  setModel(model: MapModel | null) {
    if (model === this.model) return;
    this.model = model;
    if (!this.lost) this.upload();
  }

  /** Sun shadows on or off (the High quality setting). The shadow map is made the first time it is needed. */
  setShadows(on: boolean) {
    this.shadows = on;
    if (!on) this.freeShadowMap();
  }

  /** The open interiors' slices (InteriorIndex.slices), or null when none is open. */
  setSlices(data: Float32Array | null, force = false) {
    if (data === this.sliceData && !force) return;
    this.sliceData = data;
    this.sliceCount = 0;
    const gl = this.gl;
    if (!data?.length || !this.sliceProgram || !this.sliceBuffer || this.lost || gl.isContextLost()) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sliceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.sliceCount = data.length / SLICE_STRIDE;
  }

  private freeSliceMap() {
    const s = this.sliceMap;
    if (s && !this.gl.isContextLost()) {
      this.gl.deleteFramebuffer(s.fb);
      this.gl.deleteRenderbuffer(s.depth);
      this.gl.deleteTexture(s.texture);
    }
    this.sliceMap = null;
  }

  /**
   * Draws the open interiors' slices into the slice map (made, or remade, the canvas's size), each texel the depth of
   * the nearest slice there and 0 where there is none. False when there is nothing to draw or it can't be drawn.
   */
  private drawSlices(matrix: Float32Array): boolean {
    const gl = this.gl;
    if (!this.sliceCount || !this.sliceProgram) return false;
    const { width, height } = this.canvas;
    if (this.sliceMap && (this.sliceMap.width !== width || this.sliceMap.height !== height)) this.freeSliceMap();
    if (!this.sliceMap) {
      const texture = gl.createTexture()!;
      const depth = gl.createRenderbuffer()!;
      const fb = gl.createFramebuffer()!;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.sliceMap = { texture, depth, fb, width, height };
      if (!ok) {
        this.freeSliceMap();
        this.sliceProgram = null; // not on this GPU: interiors stay covered
        return false;
      }
    }
    const p = this.sliceProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sliceMap.fb);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0); // no slice
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS); // the nearest slice
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'u_matrix'), false, matrix);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sliceBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, SLICE_STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, SLICE_STRIDE * 4, 12);
    gl.disableVertexAttribArray(2);
    gl.drawArrays(gl.TRIANGLES, 0, this.sliceCount);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sliceBox = sliceBox(this.sliceData!, matrix, width, height);
    return true;
  }

  private upload() {
    const gl = this.gl;
    const m = this.model;
    this.freeShadowMap();
    if (!m) {
      this.count = 0;
      return;
    }
    // The usual street height, for the shade that darkens the bottom of walls a little.
    const g = Array.from(m.ground).sort((a, b) => a - b);
    this.street = g[Math.floor(g.length / 2)] ?? 0;
    const [low, high] = heightRange(m);
    this.light = sunMatrix(low - 1, high + 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, modelVertices(m), gl.STATIC_DRAW);
    this.count = m.indices.length;
  }

  private freeShadowMap() {
    if (this.shadowMap && !this.gl.isContextLost()) this.gl.deleteTexture(this.shadowMap);
    this.shadowMap = null;
  }

  /** Renders the shadow map: the model seen from the sun, its depths packed into the texture's four bytes. */
  private makeShadowMap(): boolean {
    const gl = this.gl;
    if (!this.depthProgram || !this.light || !this.count) return false;
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    // 4096 (about 7 world units a texel) where the GPU is a desktop one, else 2048.
    const size = max >= 8192 ? 4096 : Math.min(2048, max);
    const tex = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const fb = gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) {
      gl.viewport(0, 0, size, size);
      gl.clearColor(1, 1, 1, 1); // nothing there: as far from the sun as can be
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.depthProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.depthProgram, 'u_light'), false, this.light);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
      gl.disableVertexAttribArray(1);
      gl.disableVertexAttribArray(2);
      gl.drawArrays(gl.TRIANGLES, 0, this.count);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(depth); // the texture keeps the depths
    if (!ok) {
      gl.deleteTexture(tex);
      this.depthProgram = null; // not on this GPU: no shadows
      return false;
    }
    this.shadowMap = tex;
    this.shadowSize = size;
    return true;
  }

  /**
   * Draws the model through `matrix` (map space → clip space, see clipMatrix), cut open where interiors are (see
   * setSlices). `then` draws more into the scene (the models standing on the map), hidden by the map where it is
   * behind it.
   */
  draw(matrix: Float32Array, then?: () => void) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost() || !this.program) return;
    const shadowed = this.shadows && !!this.shadowProgram && (!!this.shadowMap || this.makeShadowMap());
    const sliced = !!this.count && this.drawSlices(matrix);
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.count) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const p = shadowed ? this.shadowProgram! : this.program;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'u_matrix'), false, matrix);
    gl.uniform3fv(gl.getUniformLocation(p, 'u_sun'), SUN);
    // Roofs (sky and full sun) come to about 1, walls facing the sun to 0.6, walls in shade to 0.25.
    gl.uniform3f(gl.getUniformLocation(p, 'u_sunColor'), 0.82, 0.7, 0.55);
    gl.uniform3f(gl.getUniformLocation(p, 'u_sky'), 0.3, 0.34, 0.42);
    gl.uniform3f(gl.getUniformLocation(p, 'u_bounce'), 0.16, 0.14, 0.12);
    gl.uniform1f(gl.getUniformLocation(p, 'u_street'), this.street);
    if (shadowed) {
      gl.uniformMatrix4fv(gl.getUniformLocation(p, 'u_light'), false, this.light!);
      gl.uniform1f(gl.getUniformLocation(p, 'u_texel'), 1 / this.shadowSize);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowMap);
      gl.uniform1i(gl.getUniformLocation(p, 'u_shadowMap'), 1);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, sliced ? this.sliceMap!.texture : null);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(p, 'u_slices'), 2);
    gl.uniform2f(gl.getUniformLocation(p, 'u_pixel'), sliced ? 1 / width : 0, sliced ? 1 / height : 0);
    // About 1.5 CSS pixels.
    const rim = Math.max(1, (1.5 * width) / Math.max(1, this.canvas.clientWidth));
    gl.uniform1f(gl.getUniformLocation(p, 'u_rim'), rim);
    const [x0, y0, x1, y1] = this.sliceBox;
    gl.uniform4f(gl.getUniformLocation(p, 'u_box'), x0 - rim - 1, y0 - rim - 1, x1 + rim + 1, y1 + rim + 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.BYTE, true, STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, STRIDE, 16);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.disableVertexAttribArray(2);
    // The slice map is drawn into again next frame: not left bound where a program could read it then.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    then?.();
  }

  /** Frees this renderer's GPU resources; the context itself belongs to the canvas's owner. */
  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (!this.gl.isContextLost()) {
      this.gl.deleteBuffer(this.buffer);
      this.gl.deleteBuffer(this.sliceBuffer);
      this.gl.deleteProgram(this.program);
      this.gl.deleteProgram(this.shadowProgram);
      this.gl.deleteProgram(this.depthProgram);
      this.gl.deleteProgram(this.sliceProgram);
      this.freeShadowMap();
      this.freeSliceMap();
    }
  }
}
