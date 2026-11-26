/**
 * Draws the models standing on the 3D view's map (mapObjects.ts) with WebGL: each placement through its own model
 * matrix, flat-shaded and lit like the map, and their glowing parts (eyes, flames, the power-up's crystal) in their
 * own colour. What the city hides of them (base guardians stand in halls, guardians and walkers in streets between
 * tall buildings) shows through faintly, as a game shows objectives through walls. Shares the canvas's context with
 * the map's renderer, which calls it between its passes.
 */
import { MAP_SIZE } from './mapCamera';
import { SUN } from './mapModelRenderer';
import { grownBy, type ObjectModel } from './mapObjects';
import { buildProgram } from './mapRenderer';

/** How strongly what the city hides of a model shows through it. */
const GHOST_OPACITY = 0.38;

const VERTEX = `
attribute vec3 a_pos;
attribute vec3 a_normal;
attribute vec4 a_color;
uniform mat4 u_matrix;
uniform mat4 u_model;
uniform mat3 u_turn;
varying vec3 v_normal;
varying vec4 v_color;
void main() {
  v_normal = u_turn * a_normal;
  v_color = a_color;
  gl_Position = u_matrix * u_model * vec4(a_pos, 1.0);
}`;

// The map's light (see mapModelRenderer.ts), in linear light; glowing triangles show their colour unlit. The ghost
// pass draws what is hidden see-through.
const FRAGMENT = `
precision mediump float;
uniform vec3 u_sun;
uniform vec3 u_sunColor;
uniform vec3 u_sky;
uniform vec3 u_bounce;
uniform float u_ghost;
varying vec3 v_normal;
varying vec4 v_color;
void main() {
  vec3 n = normalize(v_normal);
  vec3 albedo = pow(v_color.rgb, vec3(2.2));
  vec3 light = mix(u_bounce, u_sky, n.z * 0.5 + 0.5) + u_sunColor * max(dot(n, u_sun), 0.0);
  vec3 c = mix(albedo * light, albedo * 1.1, v_color.a);
  gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0 - u_ghost * ${(1 - GHOST_OPACITY).toFixed(2)});
}`;

/** Bytes per vertex: position (3 floats, model units), normal (3 signed bytes + pad), colour and glow (4 bytes). */
const STRIDE = 20;

/** One vertex per triangle corner, so each triangle has its own normal (from its winding) and colour. */
export function objectVertices(model: ObjectModel, colours: Uint8Array): ArrayBuffer {
  const { positions: P, indices: I } = model;
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
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
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
      u8.set(colours.subarray(t * 4, t * 4 + 4), o + 16);
    }
  }
  return buf;
}

/** A model placed on the map: where it stands in map units (x, y as on the map, h its height) and its facing. */
export interface ObjectDraw {
  model: ObjectModel;
  colours: Uint8Array;
  x: number;
  y: number;
  h: number;
  /** Degrees anticlockwise from east, as the game has it. */
  yaw: number;
}

/**
 * Column-major matrices from a model's units to map space: turned to its yaw and scaled in the game's world (x east,
 * y north), grown `grow` times about its feet, then into the map's units, where y points south. The y flip mirrors
 * the model; its normals take the same turn and flip (`turn`), which keeps them pointing out of it.
 */
export function placementMatrices(d: ObjectDraw, radius: number, grow = 1): { model: Float32Array; turn: Float32Array } {
  const k = (MAP_SIZE / (2 * radius)) * d.model.scale * grow;
  const a = (d.yaw * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    model: new Float32Array([k * c, -k * s, 0, 0, -k * s, -k * c, 0, 0, 0, 0, k, 0, d.x, d.y, d.h, 1]),
    turn: new Float32Array([c, -s, 0, -s, -c, 0, 0, 0, 1]),
  };
}

export class ObjectRenderer {
  private program: WebGLProgram | null = null;
  /** Vertices of each model in each skin, made the first time it is drawn. */
  private buffers = new Map<Uint8Array, { buffer: WebGLBuffer; count: number }>();

  private constructor(private readonly gl: WebGLRenderingContext) {
    this.init();
  }

  /** A renderer on the canvas's shared WebGL context, or null when its shaders can't be built. */
  static create(gl: WebGLRenderingContext): ObjectRenderer | null {
    try {
      return new ObjectRenderer(gl);
    } catch {
      return null;
    }
  }

  private init() {
    this.program = buildProgram(this.gl, VERTEX, FRAGMENT, ['a_pos', 'a_normal', 'a_color']);
    this.buffers = new Map(); // a restored context has none of the old ones
  }

  private vertices(model: ObjectModel, colours: Uint8Array) {
    let v = this.buffers.get(colours);
    if (!v) {
      const gl = this.gl;
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, objectVertices(model, colours), gl.STATIC_DRAW);
      v = { buffer, count: model.indices.length };
      this.buffers.set(colours, v);
    }
    return v;
  }

  /**
   * Draws the placed models through `matrix` (map space → clip space) into what is already on the canvas: first,
   * faintly, what the map hides of them, then what can be seen. `radius` is the map's (world units from its middle to
   * its edge); `grow` makes the models that many times their size, about their feet, though none taller than
   * GROWN_HEIGHT (see grownBy).
   */
  draw(matrix: Float32Array, list: ObjectDraw[], radius: number, grow = 1) {
    const gl = this.gl;
    if (!list.length || gl.isContextLost()) return;
    // A context lost and restored since (the map's renderer draws again as soon as it is back) has none of this
    // renderer's program and buffers: make them again.
    if (!this.program || !gl.isProgram(this.program)) {
      try {
        this.init();
      } catch {
        return;
      }
    }
    const p = this.program!;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'u_matrix'), false, matrix);
    gl.uniform3fv(gl.getUniformLocation(p, 'u_sun'), SUN);
    gl.uniform3f(gl.getUniformLocation(p, 'u_sunColor'), 0.82, 0.7, 0.55);
    gl.uniform3f(gl.getUniformLocation(p, 'u_sky'), 0.3, 0.34, 0.42);
    gl.uniform3f(gl.getUniformLocation(p, 'u_bounce'), 0.16, 0.14, 0.12);
    const modelAt = gl.getUniformLocation(p, 'u_model');
    const turnAt = gl.getUniformLocation(p, 'u_turn');
    const ghost = gl.getUniformLocation(p, 'u_ghost');
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enableVertexAttribArray(2);
    const pass = () => {
      for (const d of list) {
        const { buffer, count } = this.vertices(d.model, d.colours);
        const m = placementMatrices(d, radius, grownBy(d.model, grow));
        gl.uniformMatrix4fv(modelAt, false, m.model);
        gl.uniformMatrix3fv(turnAt, false, m.turn);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
        gl.vertexAttribPointer(1, 3, gl.BYTE, true, STRIDE, 12);
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 16);
        gl.drawArrays(gl.TRIANGLES, 0, count);
      }
    };
    // Hidden by the map: see-through, leaving the depths as they are. Then what can be seen draws over it.
    gl.depthFunc(gl.GREATER);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(ghost, 1);
    pass();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1f(ghost, 0);
    pass();
    gl.disableVertexAttribArray(2);
  }

  /** Frees this renderer's GPU resources; the context itself belongs to the canvas's owner. */
  dispose() {
    if (!this.gl.isContextLost()) {
      for (const { buffer } of this.buffers.values()) this.gl.deleteBuffer(buffer);
      this.gl.deleteProgram(this.program);
    }
    this.buffers.clear();
  }
}
