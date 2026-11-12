import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';
import solid from 'vite-plugin-solid';

const core = process.env.CORE_URL ?? 'http://localhost:8081';

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': core,
      '/ws': { target: core.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts'],
    // The tests are plain logic (no DOM), so they don't need jsdom.
    environment: 'node',
  },
  lint: {
    ignorePatterns: ['dist/**', 'node_modules/**', 'src/api/schema.d.ts'],
  },
  fmt: {
    semi: true,
    singleQuote: true,
  },
});
