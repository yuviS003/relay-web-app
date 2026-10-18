import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirrors the tsconfig "@/*" path so tests and transitive imports resolve
    // modules the same way the application does.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Loads .env so the Mongo suite can reach a real cluster; suites that
    // need credentials skip themselves when it is absent.
    setupFiles: ['./tests/setup-env.ts'],
    // The relay and sandbox suites bind sockets and spin up WASM runtimes,
    // which is slower than a unit test and needs headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
