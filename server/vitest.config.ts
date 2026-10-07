import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // PGlite fixtures each load a PostgreSQL runtime. Bound memory on the CI runner.
    maxWorkers: 2,
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
