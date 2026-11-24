import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Harness } from './harness';

/**
 * The realtime map's WebGL renderers in a real browser (e2e/harness.ts, drawing in software): their shaders build, the
 * model, the objects and the 2.5D terrain draw, and a hero's interior opens, in made-up scenes and in the real map:
 * what stands in front of its floor goes, a rim marks the cut, and it all comes back when it closes.
 */
type Xyz = [number, number, number];
const heroes = JSON.parse(readFileSync(new URL('./fixtures/heroes.json', import.meta.url), 'utf8')) as { arena: Xyz[]; hidden: Xyz[] };
type Page = { harness: Harness };

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/harness.html');
  await expect(page).toHaveTitle('ready');
});

test('every shader builds: the model with and without shadows, its slices, the objects and the terrain', async ({ page }) => {
  const programs = await page.evaluate(() => (window as unknown as Page).harness.programs());
  expect(programs).toEqual({ model: true, shadows: true, shadowDepth: true, slices: true, objects: true, terrain: true });
});

for (const shadows of [false, true]) {
  test(`an interior opens round its hero, its floor showing through the roof inside a rim, and closes again${shadows ? ' (with shadows)' : ''}`, async ({ page }) => {
    const r = await page.evaluate((s) => (window as unknown as Page).harness.cut(s), shadows);
    expect(r.error).toBe(0);
    // Closed: the roof, all the way out from the middle; and the same again once the hero has left.
    expect(new Set(r.closed)).toEqual(new Set(['roof']));
    expect(r.closedAgain).toEqual(r.closed);
    // Open: the floor (red, darker) inside the opening, the roof (blue) outside it, the rim between.
    const edge = Math.round(r.edge);
    expect(edge).toBeGreaterThan(20);
    expect(new Set(r.open.slice(0, edge - 3))).toEqual(new Set(['floor']));
    expect(new Set(r.open.slice(edge + 4))).toEqual(new Set(['roof']));
    expect(r.open.slice(edge - 3, edge + 4)).toContain('rim');
  });
}

test('in the real map, a hero in the Mid-Boss hall opens it: the plaza over the hero goes, the rest stays', async ({ page }) => {
  for (const at of [heroes.arena[0]!, heroes.arena[60]!]) {
    const r = await page.evaluate((p) => (window as unknown as Page).harness.opening(p), at);
    expect(r.footing, `${at}`).not.toBeNull();
    expect(r.error).toBe(0);
    expect(r.drawn).toBeGreaterThan(0.5); // the map fills the view
    expect(r.near).toBeGreaterThan(0.25); // round the hero, the plaza gives way to the hall below
    expect(r.far).toBeLessThan(0.01); // the view's corners don't change
    expect(r.again).toBeLessThan(0.001); // closed, it is as it was
  }
});

test('in the real map, heroes in tunnels and halls open theirs, in the High quality model too', async ({ page }) => {
  let opened = 0;
  for (const at of heroes.hidden.slice(0, 40)) {
    const r = await page.evaluate((p) => (window as unknown as Page).harness.opening(p), at);
    if (!r.footing) continue; // a nook left covered on purpose
    expect(r.error).toBe(0);
    expect(r.near, `${at}`).toBeGreaterThan(0.05);
    expect(r.far).toBeLessThan(0.01);
    expect(r.again).toBeLessThan(0.001);
    if (++opened === 3) break;
  }
  expect(opened).toBe(3);
  const high = await page.evaluate((p) => (window as unknown as Page).harness.opening(p, '/maps/dl_midtown.high.bin.gz'), heroes.arena[0]!);
  expect(high.footing).not.toBeNull();
  expect(high.near).toBeGreaterThan(0.25);
  expect(high.far).toBeLessThan(0.01);
});

test('the guardians, walkers and base guardians of both teams and the crystal of every power-up kind draw', async ({ page }) => {
  const r = await page.evaluate(() => (window as unknown as Page).harness.objects());
  expect(r.error).toBe(0);
  for (const cover of [...r.walker, ...r.guardian, ...r.baseGuardian, ...r.powerup]) expect(cover).toBeGreaterThan(0.001);
});

test("the 2.5D view's terrain traces the minimap's buildings and raises them", async ({ page }) => {
  const r = await page.evaluate(() => (window as unknown as Page).harness.terrain());
  expect(r.error).toBe(0);
  expect(r.walls).toBeGreaterThanOrEqual(16 * 4); // 16 square buildings, four walls each at least
  expect(r.drawn).toBeGreaterThan(0.2);
  expect(r.buildings).toBeGreaterThan(0.01); // laid flat, they look different
});
