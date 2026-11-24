/**
 * Draws the 2.5D map's ground and buildings with WebGL: the streets (shaded as on the minimap), the buildings' walls
 * and roofs, and the map's edge reaching down below the streets. The markers are drawn over it in SVG.
 */
import { BUILDING_HEIGHT, EDGE_DEPTH, type Terrain } from './mapTerrain';
import { MAP_SIZE } from './mapCamera';

export type Rgb = [number, number, number];

export interface TerrainColors {
  /** Open street, and street right against a wall (the minimap's own shading). */
  street: Rgb;
  streetShade: Rgb;
  wall: Rgb;
  roof: Rgb;
  /** The rim of the roofs. */
  roofEdge: Rgb;
  /** The map's edge below the streets. */
  edge: Rgb;
}

const VERTEX = `
attribute vec3 a_pos;
attribute float a_light;
uniform mat4 u_matrix;
varying vec2 v_uv;
varying float v_light;
varying float v_h;
void main() {
  v_uv = a_pos.xy / ${MAP_SIZE.toFixed(1)};
  v_light = a_light;
  v_h = a_pos.z;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

// Modes: 0 ground, 1 walls, 2 roofs, 3 the map's edge. The texture is the terrain's: R street shade, G building,
// B inside the map. Colours are premultiplied by alpha.
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_tex;
uniform int u_mode;
uniform float u_flat;
uniform vec3 u_street;
uniform vec3 u_streetShade;
uniform vec3 u_wall;
uniform vec3 u_roof;
uniform vec3 u_roofEdge;
uniform vec3 u_edge;
varying vec2 v_uv;
varying float v_light;
varying float v_h;
void main() {
  if (u_mode == 0) {
    vec4 t = texture2D(u_tex, v_uv);
    float a = smoothstep(0.3, 0.7, t.b);
    if (a < 0.01) discard;
    vec3 c = mix(u_street, u_streetShade, t.r);
    c = mix(c, u_roof, u_flat * smoothstep(0.3, 0.7, t.g));
    gl_FragColor = vec4(c * a, a);
  } else if (u_mode == 1) {
    float foot = mix(0.6, 1.0, clamp(v_h / ${BUILDING_HEIGHT.toFixed(1)}, 0.0, 1.0));
    gl_FragColor = vec4(u_wall * v_light * foot, 1.0);
  } else if (u_mode == 2) {
    float g = texture2D(u_tex, v_uv).g;
    if (g < 0.5) discard;
    gl_FragColor = vec4(mix(u_roofEdge, u_roof, smoothstep(0.55, 0.95, g)), 1.0);
  } else {
    float fade = clamp(1.0 + v_h / ${EDGE_DEPTH.toFixed(1)}, 0.0, 1.0);
    gl_FragColor = vec4(u_edge * v_light * fade, fade);
  }
}`;

/** Where the light comes from, on the map (south-west, so the walls facing the default view are lit). */
const LIGHT: [number, number] = [-0.6, 0.8];

/** Light on a wall facing (nx, ny). */
function lightOn(nx: number, ny: number): number {
  return 0.58 + 0.36 * (nx * LIGHT[0] + ny * LIGHT[1]);
}

/** Two triangles per wall segment, from height `from` to `to`: x, y, h, light per vertex. */
function wallMesh(segments: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array((segments.length / 4) * 6 * 4);
  let o = 0;
  for (let i = 0; i < segments.length; i += 4) {
    const x0 = segments[i]!;
    const y0 = segments[i + 1]!;
    const x1 = segments[i + 2]!;
    const y1 = segments[i + 3]!;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const l = lightOn((y0 - y1) / len, (x1 - x0) / len);
    for (const [x, y, h] of [[x0, y0, from], [x1, y1, from], [x1, y1, to], [x0, y0, from], [x1, y1, to], [x0, y0, to]]) {
      out[o++] = x!;
      out[o++] = y!;
      out[o++] = h!;
      out[o++] = l;
    }
  }
  return out;
}

function square(h: number): Float32Array {
  const s = MAP_SIZE;
  return new Float32Array([0, 0, h, 1, s, 0, h, 1, s, s, h, 1, 0, 0, h, 1, s, s, h, 1, 0, s, h, 1]);
}

/** A board with no buildings, for maps without a minimap image. */
const PLAIN: Terrain = {
  size: 1,
  pixels: new Uint8Array([0, 0, 255, 255]),
  walls: new Float32Array(),
  edge: new Float32Array([0, 0, 0, MAP_SIZE, 0, MAP_SIZE, MAP_SIZE, MAP_SIZE, MAP_SIZE, MAP_SIZE, MAP_SIZE, 0, MAP_SIZE, 0, 0, 0]),
};

interface Mesh {
  buffer: WebGLBuffer;
  count: number;
}

export class TerrainRenderer {
  private readonly gl: WebGLRenderingContext;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private meshes: { ground: Mesh; roof: Mesh; walls: Mesh; edge: Mesh } | null = null;
  private terrain: Terrain | null = null;
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
    gl: WebGLRenderingContext,
    private readonly restored?: () => void,
  ) {
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.init();
  }

  /**
   * A renderer on the canvas's WebGL context (shared with the model renderer), or null when its shaders can't be
   * built. `restored` is called to redraw after a context loss.
   */
  static create(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, restored?: () => void): TerrainRenderer | null {
    try {
      return new TerrainRenderer(canvas, gl, restored);
    } catch {
      return null;
    }
  }

  private init() {
    const gl = this.gl;
    this.program = buildProgram(gl, VERTEX, FRAGMENT, ['a_pos', 'a_light']);
    this.texture = gl.createTexture();
    this.meshes = null;
  }

  /** The terrain to draw; null draws a plain board. */
  setTerrain(t: Terrain | null) {
    this.terrain = t;
    if (!this.lost) this.upload();
  }

  private upload() {
    const gl = this.gl;
    const t = this.terrain ?? PLAIN;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.size, t.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const pow2 = (t.size & (t.size - 1)) === 0;
    if (pow2) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pow2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    // The map is seen at a slant: sharper far away with anisotropic filtering, where available.
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number));

    const mesh = (data: Float32Array, old?: Mesh): Mesh => {
      const buffer = old?.buffer ?? gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { buffer, count: data.length / 4 };
    };
    const old = this.meshes;
    this.meshes = {
      ground: mesh(square(0), old?.ground),
      roof: mesh(square(BUILDING_HEIGHT), old?.roof),
      walls: mesh(wallMesh(t.walls, 0, BUILDING_HEIGHT), old?.walls),
      edge: mesh(wallMesh(t.edge, -EDGE_DEPTH, 0), old?.edge),
    };
  }

  /** Clears the canvas. */
  clear() {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Draws the terrain through `matrix` (map space → clip space, see clipMatrix); `buildings` false lays them flat. */
  draw(matrix: Float32Array, colors: TerrainColors, buildings: boolean) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost() || !this.program) return;
    if (!this.meshes) this.upload();
    const meshes = this.meshes!;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    const p = this.program;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'u_matrix'), false, matrix);
    gl.uniform1f(gl.getUniformLocation(p, 'u_flat'), buildings ? 0 : 1);
    for (const [name, rgb] of Object.entries(colors) as [keyof TerrainColors, Rgb][]) {
      gl.uniform3f(gl.getUniformLocation(p, `u_${name}`), rgb[0], rgb[1], rgb[2]);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(p, 'u_tex'), 0);

    const mode = gl.getUniformLocation(p, 'u_mode');
    const run = (m: Mesh, which: number) => {
      if (!m.count) return;
      gl.uniform1i(mode, which);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      gl.disableVertexAttribArray(2); // the model renderer's, on the shared context
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
    };
    run(meshes.edge, 3);
    run(meshes.ground, 0);
    if (buildings) {
      run(meshes.walls, 1);
      run(meshes.roof, 2);
    }
  }

  /** Frees this renderer's GPU resources; the context itself belongs to the canvas's owner. */
  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    const gl = this.gl;
    if (!gl.isContextLost()) {
      for (const m of Object.values(this.meshes ?? {})) gl.deleteBuffer(m.buffer);
      gl.deleteTexture(this.texture);
      gl.deleteProgram(this.program);
    }
  }
}

/** Compiles and links a program, binding the attributes to locations 0, 1, … in order. */
export function buildProgram(gl: WebGLRenderingContext, vertex: string, fragment: string, attributes: string[]): WebGLProgram {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
  return program;
}

/** The canvas's WebGL context, as both renderers want it; null without WebGL. */
export function webgl(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  return canvas.getContext('webgl', { alpha: true, antialias: true, depth: true, premultipliedAlpha: true });
}
