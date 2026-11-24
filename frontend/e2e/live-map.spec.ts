import { expect, test, type Locator, type Page } from '@playwright/test';
import { colours, decodePng, drawnShare, encodePng } from './png';

/**
 * The live match page's map against the mock core (e2e/mock-core.mjs): a simulated match with heroes on the lanes, four
 * of them replaying real paths through the Mid-Boss hall, a tunnel out of it and two covered halls, and both bridge
 * power-ups waiting. Nothing outside localhost is fetched: deadlock-api's hero icons are refused, and the minimap the
 * 2.5D view traces is a made-up one.
 */
const MATCH = '/live/424242';
const PLAYERS = ['Brass Fox', 'Night Owl', 'Copper', 'Lantern', 'Gearwork', 'Sootfall', 'Marrow', 'Velvet', 'Ash Moth', 'Tinsel', 'Rook', 'Quill'];

/** A round map of dark, half see-through streets with square buildings (clear holes) in it. */
function minimap(): Buffer {
  const side = 256;
  const rgba = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const inMap = Math.hypot(x - side / 2, y - side / 2) < side * 0.45;
      const inBuilding = x >= 60 && x < 200 && y >= 60 && y < 200 && (x - 60) % 36 < 20 && (y - 60) % 36 < 20;
      if (inMap && !inBuilding) rgba.set([20, 18, 30, 180], (y * side + x) * 4);
    }
  }
  return encodePng({ width: side, height: side, rgba });
}

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Refused images and a socket that reconnects are expected here; anything else the page reports is not.
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|WebSocket/.test(m.text())) errors.push(m.text());
  });
  await page.route(
    (url) => url.hostname !== 'localhost',
    (route) =>
      route.request().url().includes('minimap')
        ? route.fulfill({ body: minimap(), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } })
        : route.abort(),
  );
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function openMatch(page: Page, view: '2D' | '2.5D' | '3D'): Promise<Locator> {
  await page.goto(MATCH);
  await page.getByRole('radiogroup', { name: 'Map view' }).getByRole('radio', { name: view, exact: true }).click();
  await expect(page.getByRole('radio', { name: view, exact: true })).toHaveAttribute('aria-checked', 'true');
  return page.locator('[aria-roledescription="map"]');
}

/** How much of the canvas is drawn, and in how many colours. */
async function picture(canvas: Locator) {
  const image = decodePng(await canvas.screenshot());
  return { drawn: drawnShare(image), colours: colours(image) };
}

/** A hero's marker in the view: the SVG group titled with its hero's and player's names. */
const marker = (view: Locator, player: string) => view.locator('g', { has: view.page().locator(`title:text-matches(" · ${player}$")`) }).last();

/** How wide a hero's portrait is drawn: markers grow as the view zooms in. */
const portraitWidth = async (hero: Locator) => (await hero.locator('image').first().boundingBox())!.width;

test('2D: every hero, the objectives, and both bridge power-ups with their kind and what it gives', async ({ page }) => {
  await openMatch(page, '2D');
  for (const player of PLAYERS) await expect(page.locator('svg title', { hasText: ` · ${player}` }).first()).toBeAttached();
  const powerups = page.locator('svg title', { hasText: 'power-up · ' });
  await expect(powerups).toHaveCount(2);
  for (const title of await powerups.allTextContents()) expect(title).toMatch(/^(Gun|Survival|Casting|Movement) power-up · \w/);
  await expect(page.getByText(/waiting/).first()).toBeVisible();
});

test("3D: the game's map loads and draws with every hero on it, and heroes in interiors open them", async ({ page }) => {
  const view = await openMatch(page, '3D');
  await expect(view).toHaveAttribute('data-scene', 'model');
  await expect(page.getByText('Loading the 3D map…')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText("The 3D map couldn't be loaded")).toHaveCount(0);
  const canvas = view.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await picture(canvas)).drawn, { timeout: 60_000 }).toBeGreaterThan(0.3);
  expect((await picture(canvas)).colours).toBeGreaterThan(60);
  for (const player of PLAYERS) await expect(view.locator('title', { hasText: ` · ${player}` }).first()).toBeAttached();
  // The mock's heroes in the Mid-Boss hall and its tunnel always are; those in the halls are, most of their path.
  await expect.poll(async () => Number(await view.getAttribute('data-open-interiors')), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
});

test('3D: following a hero in the Mid-Boss hall keeps it in the middle of a zoomed-in view, its hall open', async ({ page }) => {
  const view = await openMatch(page, '3D');
  await expect(page.getByText('Loading the 3D map…')).toHaveCount(0, { timeout: 60_000 });
  const hero = marker(view, 'Night Owl');
  const box = (await view.boundingBox())!;
  /** How far the hero's feet are from the middle of the view (its marker stands above them), in pixels. */
  const offCentre = async () => {
    const at = (await hero.boundingBox())!;
    return Math.hypot(at.x + at.width / 2 - (box.x + box.width / 2), at.y + at.height - (box.y + box.height / 2));
  };
  // Drag the hall (in the middle of the whole map) well off to the side first.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.8, { steps: 12 });
  await page.mouse.up();
  await expect.poll(offCentre).toBeGreaterThan(200);
  const before = await portraitWidth(hero);
  await hero.dispatchEvent('click'); // it moves every frame: no waiting for it to stand still
  await page.getByLabel('Follow').check();
  await expect.poll(() => portraitWidth(hero), { timeout: 30_000 }).toBeGreaterThan(before * 1.3); // zoomed in
  await expect.poll(offCentre, { timeout: 30_000 }).toBeLessThan(60);
  expect(Number(await view.getAttribute('data-open-interiors'))).toBeGreaterThanOrEqual(1);
});

test('3D: High quality loads the detailed map and draws it', async ({ page }) => {
  const view = await openMatch(page, '3D');
  await expect(page.getByText('Loading the 3D map…')).toHaveCount(0, { timeout: 60_000 });
  await page.getByLabel('High quality').check();
  await expect(page.getByText('Loading the detailed map…')).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByText("The 3D map couldn't be loaded")).toHaveCount(0);
  await expect.poll(async () => (await picture(view.locator('canvas'))).drawn, { timeout: 60_000 }).toBeGreaterThan(0.3);
  await page.getByLabel('High quality').uncheck();
});

test("2.5D: the minimap's buildings stand up, and lie flat when Buildings is off", async ({ page }) => {
  const view = await openMatch(page, '2.5D');
  await expect(view).toHaveAttribute('data-scene', 'terrain');
  const canvas = view.locator('canvas');
  await expect.poll(async () => (await picture(canvas)).drawn, { timeout: 30_000 }).toBeGreaterThan(0.2);
  const standing = decodePng(await canvas.screenshot());
  await page.getByLabel('Buildings').uncheck();
  await expect
    .poll(async () => {
      const flat = decodePng(await canvas.screenshot());
      let diff = 0;
      for (let i = 0; i < flat.rgba.length; i += 4) if (Math.abs(flat.rgba[i]! - standing.rgba[i]!) > 24) diff++;
      return diff / (flat.rgba.length / 4);
    })
    .toBeGreaterThan(0.01);
});

test('the camera: scrolling zooms in, double-clicking shows the whole map again, and the view is remembered', async ({ page }) => {
  const view = await openMatch(page, '3D');
  await expect(page.getByText('Loading the 3D map…')).toHaveCount(0, { timeout: 60_000 });
  const hero = marker(view, 'Brass Fox');
  const whole = await portraitWidth(hero);
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => portraitWidth(hero)).toBeGreaterThan(whole * 1.2);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => portraitWidth(hero)).toBeLessThan(whole * 1.1);
  await page.reload();
  await expect(page.getByRole('radio', { name: '3D', exact: true })).toHaveAttribute('aria-checked', 'true');
});
