import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // PGlite fixtures each load a PostgreSQL runtime. Bound memory on the CI runner.
    pool: 'forks',
    maxWorkers: 1,
    // Node 24 can crash while reclaiming WASM wrappers (nodejs/node#66366).
    // Test-worker-only workaround; do not change production Node/V8 options.
    execArgv: process.versions.node.startsWith('24.') ? ['--no-wasm-code-gc'] : [],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/services/**', 'src/lib/**', 'src/repositories/**'],
    },
  },
})
