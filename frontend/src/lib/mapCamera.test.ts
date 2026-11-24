import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_TILT,
  MAP_SIZE,
  MAX_TILT,
  MAX_ZOOM,
  anchored,
  canvasScale,
  clampCamera,
  clipMatrix,
  cssMatrix,
  groundSquash,
  homeView,
  projector,
  rad,
  unproject,
  wrapAngle,
  zoomAround,
  zoomLimits,
  type Camera,
  type Viewport,
} from './mapCamera';

const vp: Viewport = { width: 800, height: 600 };
const cam = (c: Partial<Camera> = {}): Camera => ({ x: 500, y: 500, zoom: 1, yaw: 0, tilt: DEFAULT_TILT, ...c });

/** A few cameras far from the default: turned, flat, steep, zoomed, off-centre. */
const CAMERAS: Camera[] = [
  cam(),
  cam({ yaw: rad(90) }),
  cam({ yaw: rad(-135), tilt: MAX_TILT, zoom: 3, x: 120, y: 860 }),
  cam({ tilt: 0, zoom: 0.8 }),
  cam({ yaw: rad(30), tilt: rad(20), zoom: MAX_ZOOM, x: 990, y: 10 }),
];

describe('projector', () => {
  it('puts the target in the middle of the view', () => {
    for (const c of CAMERAS) {
      const p = projector(c, vp)(c.x, c.y);
      expect(p.x).toBeCloseTo(vp.width / 2, 6);
      expect(p.y).toBeCloseTo(vp.height / 2, 6);
    }
  });

  it('shows north at the top, and nearer points larger', () => {
    const p = projector(cam(), vp);
    const north = p(500, 200);
    const south = p(500, 800);
    expect(north.y).toBeLessThan(south.y);
    expect(north.depth).toBeGreaterThan(south.depth);
    expect(north.scale).toBeLessThan(south.scale);
  });

  it('turns the map anticlockwise with positive yaw', () => {
    // Turned a quarter: east is at the top and north on the left.
    const p = projector(cam({ yaw: rad(90) }), vp);
    expect(p(800, 500).y).toBeLessThan(vp.height / 2);
    expect(p(500, 200).x).toBeLessThan(vp.width / 2);
  });

  it('lifts points with height; looking straight down, height only brings them closer', () => {
    expect(projector(cam(), vp)(400, 400, 30).y).toBeLessThan(projector(cam(), vp)(400, 400, 0).y);
    const flat = projector(cam({ tilt: 0 }), vp);
    const low = flat(400, 400, 0);
    const high = flat(400, 400, 30);
    expect(high.depth).toBeLessThan(low.depth);
    // Same direction from the middle of the view, further out.
    const ratio = high.scale / low.scale;
    expect(high.x - vp.width / 2).toBeCloseTo((low.x - vp.width / 2) * ratio, 6);
    expect(high.y - vp.height / 2).toBeCloseTo((low.y - vp.height / 2) * ratio, 6);
  });

  it('never puts a map point behind the camera', () => {
    for (const yaw of [0, 1, 2, 3, 4, 5, 6]) {
      for (const [x, y] of [[0, 0], [1000, 1000], [0, 1000], [1000, 0]]) {
        const p = projector(cam({ yaw, tilt: MAX_TILT, x: x!, y: y! }), vp);
        for (const [cx, cy] of [[0, 0], [1000, 1000], [0, 1000], [1000, 0]]) {
          expect(p(cx!, cy!, -40).depth).toBeGreaterThan(200);
          expect(p(cx!, cy!, 80).depth).toBeGreaterThan(200);
        }
      }
    }
  });
});

describe('unproject', () => {
  it('inverts the projection, on the ground and above it', () => {
    for (const c of CAMERAS) {
      const p = projector(c, vp);
      for (const [x, y, h] of [[100, 200, 0], [500, 500, 0], [900, 750, 13], [320, 610, 40]]) {
        const s = p(x!, y!, h);
        const g = unproject(c, vp, s.x, s.y, h);
        expect(g).not.toBeNull();
        expect(g![0]).toBeCloseTo(x!, 6);
        expect(g![1]).toBeCloseTo(y!, 6);
      }
    }
  });

  it('finds no ground above the horizon', () => {
    // Very zoomed out and tilted, far above the top of the view.
    expect(unproject(cam({ tilt: MAX_TILT }), vp, 400, -20_000)).toBeNull();
  });
});

describe('homeView', () => {
  it('shows the whole playable circle inside the view, north up', () => {
    const home = homeView(vp);
    expect(home).toMatchObject({ zoom: 1, yaw: 0, tilt: DEFAULT_TILT });
    const p = projector(home, vp);
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < 360; i++) {
      const t = rad(i);
      const s = p(500 + 500 * Math.cos(t), 500 + 500 * Math.sin(t));
      top = Math.min(top, s.y);
      bottom = Math.max(bottom, s.y);
      left = Math.min(left, s.x);
      right = Math.max(right, s.x);
    }
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(vp.width);
    expect(top).toBeGreaterThan(0.05 * vp.height); // room at the top for markers standing up
    expect(bottom).toBeLessThanOrEqual(vp.height);
    // It fills the view in one direction (the margins aside).
    expect(Math.max((right - left) / (0.94 * vp.width), (bottom - top) / (0.86 * vp.height))).toBeCloseTo(1, 2);
  });
});

describe('camera moves', () => {
  it('keeps the map point under the cursor when zooming', () => {
    for (const c of CAMERAS.slice(0, 3)) {
      const before = unproject(c, vp, 610, 180)!;
      const next = zoomAround(c, vp, 1.6, 610, 180);
      const after = unproject(next, vp, 610, 180)!;
      if (next.x > 0 && next.x < MAP_SIZE && next.y > 0 && next.y < MAP_SIZE) {
        expect(after[0]).toBeCloseTo(before[0], 6);
        expect(after[1]).toBeCloseTo(before[1], 6);
      }
    }
  });

  it('stays within the zoom limits', () => {
    const [lo, hi] = zoomLimits(cam(), vp);
    expect(lo).toBeLessThan(1);
    expect(hi).toBe(MAX_ZOOM);
    expect(zoomAround(cam(), vp, 100, 400, 300).zoom).toBe(MAX_ZOOM);
    expect(zoomAround(cam(), vp, 0.01, 400, 300).zoom).toBeCloseTo(lo, 9);
  });

  it('moves the camera so a map point lands under a screen point', () => {
    const c = cam({ yaw: rad(40), zoom: 2 });
    const moved = anchored(c, vp, 100, 450, [300, 700]);
    const g = unproject(moved, vp, 100, 450)!;
    expect(g[0]).toBeCloseTo(300, 6);
    expect(g[1]).toBeCloseTo(700, 6);
  });

  it('clamps the target, zoom and tilt, and wraps the yaw', () => {
    const c = clampCamera({ x: -50, y: 1200, zoom: 99, yaw: rad(370), tilt: rad(85) }, vp);
    expect(c).toMatchObject({ x: 0, y: MAP_SIZE, zoom: MAX_ZOOM, tilt: MAX_TILT });
    expect(c.yaw).toBeCloseTo(rad(10), 9);
  });

  it('wraps angles into (-π, π]', () => {
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(rad(-190))).toBeCloseTo(rad(170), 9);
    expect(wrapAngle(rad(725))).toBeCloseTo(rad(5), 9);
  });
});

describe('matrices', () => {
  it('match the projector in WebGL clip space', () => {
    for (const c of CAMERAS) {
      const m = clipMatrix(c, vp);
      const p = projector(c, vp);
      for (const [x, y, h] of [[100, 200, 0], [700, 300, 13], [450, 900, -26]]) {
        const v = [x!, y!, h!, 1];
        const out = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].reduce((s, c2) => s + m[c2 * 4 + r]! * v[c2]!, 0));
        const [cx, cy, cz, cw] = out as [number, number, number, number];
        const s = p(x!, y!, h);
        expect(cw).toBeCloseTo(s.depth, 4);
        expect(((cx / cw + 1) / 2) * vp.width).toBeCloseTo(s.x, 3);
        expect(((1 - cy / cw) / 2) * vp.height).toBeCloseTo(s.y, 3);
        expect(Math.abs(cz / cw)).toBeLessThan(1); // between the near and far planes
      }
    }
  });

  it('match the projector as a CSS matrix3d for the flat map', () => {
    const c = cam({ yaw: rad(-60), zoom: 2.5, x: 300, y: 650 });
    const m = cssMatrix(c, vp).slice('matrix3d('.length, -1).split(',').map(Number);
    expect(m).toHaveLength(16);
    const p = projector(c, vp);
    for (const [x, y] of [[0, 0], [250, 800], [1000, 400]]) {
      const v = [x!, y!, 0, 1];
      const [sx, sy, , w] = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].reduce((s, c2) => s + m[c2 * 4 + r]! * v[c2]!, 0)) as [number, number, number, number];
      expect(sx / w).toBeCloseTo(p(x!, y!).x, 2);
      expect(sy / w).toBeCloseTo(p(x!, y!).y, 2);
    }
  });
});

describe('groundSquash', () => {
  it('matches how a small ground circle is flattened on screen', () => {
    const c = cam({ yaw: rad(25) });
    const p = projector(c, vp);
    const at = p(420, 380);
    // Small steps on the ground to the screen's right and away from the camera; the ellipses drawn for circles on
    // the ground are upright, so only the away step's vertical extent counts.
    const right: [number, number] = [Math.cos(c.yaw), Math.sin(c.yaw)];
    const away: [number, number] = [Math.sin(c.yaw), -Math.cos(c.yaw)];
    const e = 0.01;
    const wide = Math.hypot(p(420 + e * right[0], 380 + e * right[1]).x - at.x, p(420 + e * right[0], 380 + e * right[1]).y - at.y);
    const tall = Math.abs(p(420 + e * away[0], 380 + e * away[1]).y - at.y);
    expect(tall / wide).toBeCloseTo(groundSquash(c, at.depth), 4);
  });
});

describe('canvasScale', () => {
  const vp = { width: 800, height: 600 };

  it("uses the screen's pixels, at most 2 per CSS pixel", () => {
    expect(canvasScale(vp, 1, false)).toBe(1);
    expect(canvasScale(vp, 3, false)).toBe(2);
    expect(canvasScale(vp, 0, false)).toBe(1); // unknown
  });

  it('draws twice as fine in high quality, at most 3 per CSS pixel', () => {
    expect(canvasScale(vp, 1, true)).toBe(2);
    expect(canvasScale(vp, 1.25, true)).toBe(2.5);
    expect(canvasScale(vp, 2, true)).toBe(3);
  });

  it('keeps within the largest canvas the GPU allows', () => {
    expect(canvasScale({ width: 4000, height: 1000 }, 2, true, 8192)).toBeCloseTo(2.048, 6);
  });
});
