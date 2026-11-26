import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests of the realtime map (e2e/*.spec.ts) in a real Chromium, its WebGL drawn in software (SwiftShader, so
 * they run without a GPU), against the mock core (e2e/mock-core.mjs: a simulated live match) and Vite's dev server,
 * both started here on ports of their own.
 *
 *   npx playwright install --with-deps chromium     (once: the browser and the libraries it needs)
 *   npx playwright test
 */
const MOCK_PORT = 8091;
const PORT = 5191;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // One browser at a time: software WebGL takes the CPU.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
      },
    },
  ],
  webServer: [
    {
      command: 'node e2e/mock-core.mjs',
      url: `http://localhost:${MOCK_PORT}/api/live/assets`,
      // Nobody hits the jackpot unless a test says so (jackpot.spec.ts).
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_JACKPOT_HIT_EVERY: '0' },
      reuseExistingServer: false,
    },
    {
      command: `npx vp dev --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/`,
      env: { CORE_URL: `http://localhost:${MOCK_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
