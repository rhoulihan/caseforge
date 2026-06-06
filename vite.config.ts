import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// One config for both `vite build` (the SPA) and `vitest` (the test block). The preact() plugin
// compiles JSX in both. Global test env is `node` (the pure-function suites); component tests opt
// into jsdom per-file via a `// @vitest-environment jsdom` docblock.
//
// Dev proxy: in `vite dev` the SPA runs on a Vite port while the launcher serves its endpoints on
// 127.0.0.1:8080, so /anonymize //deanonymize //health are proxied there (override with
// VITE_LAUNCHER_ORIGIN). In production the launcher serves the built SPA, so these are same-origin.
const LAUNCHER = process.env.VITE_LAUNCHER_ORIGIN ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      '/anonymize': LAUNCHER,
      '/deanonymize': LAUNCHER,
      '/health': LAUNCHER,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
  },
});
