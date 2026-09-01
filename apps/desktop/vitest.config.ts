import { defineConfig } from 'vitest/config'

// Тести десктопу працюють із реальною SQLite через node:sqlite і створюють
// тимчасові бази у temp-каталозі. Тому середовище — node, без DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Кожен тест-файл піднімає власну LocalDatabase у своєму temp-каталозі,
    // але SQLite у WAL-режимі на Windows чутлива до паралельних відкриттів
    // одного файлу, тому файли виконуються послідовно.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
