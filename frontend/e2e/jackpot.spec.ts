import { expect, test, type Page } from '@playwright/test';

/**
 * The slots' casino-wide jackpot against the mock core (e2e/mock-core.mjs, "slots and the casino-wide jackpot"): the
 * meter rolls up as other players lose, someone else's hit shows on it (and as a note on other pages), and the
 * player's own hit gets the celebration (the mock pays the jackpot for any spin at 10.00 a line). With reduced motion
 * nothing rolls, pulses or flies, and the win shows at once. Here nobody else hits the jackpot unless a test makes them
 * (POST /api/mock/jackpot/hit; playwright.config.ts turns the mock's timer off).
 */

const tokens = (n: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const PLAYER = {
  id: 'a5e10000-0000-4000-8000-000000000001',
  username: 'tester',
  email: 'tester@example.test',
  role: 'PLAYER',
  country: 'CZ',
  dateOfBirth: '1990-01-01',
  createdAt: '2026-11-26T00:00:00Z',
};

/** Opens a page with the play-money notice read, no prompts, sound off and, if asked, logged in. */
async function open(page: Page, path: string, loggedIn = false) {
  await page.addInitScript((user) => {
    sessionStorage.setItem('naebka.disclaimer', '1');
    localStorage.setItem('naebka.prompts', JSON.stringify({ invite: 'done', pulse: 'done', rated: true }));
    localStorage.setItem('naebka.audio', JSON.stringify({ muted: true, sfxOn: false, sfxVolume: 0, musicOn: false, musicVolume: 0 }));
    if (user) {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      sessionStorage.setItem('naebka.session', JSON.stringify({ token: 'mock-token', expiresAt, user }));
    }
  }, loggedIn ? PLAYER : null);
  await page.goto(path);
  await expect(page.locator('.jp-meter')).toContainText(/\d\.\d\d/); // the pool has arrived
}

/** Raises the bet to 10.00 a line and spins: the mock's jackpot. */
async function hitTheJackpot(page: Page): Promise<number> {
  const raise = page.getByRole('button', { name: 'Raise bet' });
  while (await raise.isEnabled()) await raise.click();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/slots/spin'));
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  const result = (await (await response).json()) as { jackpotWin: number };
  expect(result.jackpotWin).toBeGreaterThan(0);
  return result.jackpotWin;
}

test('the meter rolls up as other players lose', async ({ page }) => {
  await open(page, '/slots');
  await expect(page.locator('.jp-meter')).toContainText('+2% of every losing spin');
  // Each gain floats up as "+0.07" beside the amount.
  await expect(page.locator('.jp-gain').first()).toHaveText(/^\+0\.\d\d$/, { timeout: 15_000 });
});

test("someone else's hit shows on the meter, and as a note on other pages", async ({ page }) => {
  await open(page, '/slots');
  const meter = page.locator('.jp-meter');
  const { won } = (await (await page.request.post('/api/mock/jackpot/hit')).json()) as { won: number };
  await expect(meter).toContainText('Jackpot hit!');
  await expect(meter).toContainText(/Won by .\*\*\*.!/);
  await expect(meter.locator('.sr-only')).toHaveText(tokens(won)); // the pool that was won, for a moment
  await expect(page.locator('.jp-coin').first()).toBeAttached();
  const note = page.locator('a[href="/slots"]', { hasText: 'hit the jackpot!' });
  await expect(note).toHaveCount(0); // the meter says it here

  await page.getByRole('link', { name: 'Poker' }).click();
  const again = (await (await page.request.post('/api/mock/jackpot/hit')).json()) as { won: number };
  await expect(note).toBeVisible();
  await expect(note).toContainText(`${tokens(again.won)} NTK`);
  await note.click();
  await expect(page).toHaveURL(/\/slots$/);
});

test("the player's own hit gets the celebration, not someone else's moment", async ({ page }) => {
  await open(page, '/slots', true);
  const won = await hitTheJackpot(page);
  const dialog = page.getByRole('dialog', { name: `Jackpot! You won ${tokens(won)} NTK` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/Five (Hidden King|Joker)s on a line/); // the wild of the visitor's slot icons
  await expect(dialog).toContainText(`+${tokens(won)}`); // where the count-up lands
  await expect(page.locator('.jp-meter')).not.toContainText('p***r'); // the mock's name for a player it doesn't know
  await dialog.getByRole('button', { name: 'Collect' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.jp-meter')).toContainText(/last won (now|\d+ seconds? ago)/);
});

test('with reduced motion nothing rolls, pulses or flies, and the win shows at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/slots', true);
  const still = await page.evaluate(() => ({
    wheel: getComputedStyle(document.querySelector('.jp-strip')!).transitionDuration,
    shine: getComputedStyle(document.querySelector('.jp-meter')!, '::after').animationName,
  }));
  expect(still).toEqual({ wheel: '0s', shine: 'none' });

  await page.request.post('/api/mock/jackpot/hit');
  await expect(page.locator('.jp-meter')).toContainText('Jackpot hit!');
  await expect(page.locator('.jp-coin').first()).toBeHidden();

  const won = await hitTheJackpot(page);
  const dialog = page.getByRole('dialog', { name: `Jackpot! You won ${tokens(won)} NTK` });
  await expect(dialog).toContainText(`+${tokens(won)}`, { timeout: 2_000 }); // no count-up
  expect(await dialog.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
