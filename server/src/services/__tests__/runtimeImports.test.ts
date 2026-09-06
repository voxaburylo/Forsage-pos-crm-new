import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 06.09.2026 сервер уперше імпортував спільний пакет `@crm-forsage/shared` у
 * рантаймі — і продакшн ліг: Vercel-функція віддавала FUNCTION_INVOCATION_FAILED
 * на всіх адресах, а Render працював лише тому, що не зміг зібрати нову версію
 * і далі крутив стару. Каса при цьому цілий день не синхронізувалася.
 *
 * Причина проста: `shared/package.json` вказує `main: ./src/index.ts`, тобто
 * пакет віддає сирий TypeScript. Веб це переживає — Vite транспілює на льоту.
 * Зібраний сервер — ні: у `server/dist` лишається звичайний import, і Node
 * впирається в .ts.
 *
 * Типи звідти брати можна: `import type` зникає при компіляції.
 */
const serverSrc = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('що серверу можна тягнути в рантаймі', () => {
  it('жоден серверний модуль не імпортує спільний пакет як значення', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(path.dirname(serverSrc))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/^import\s+(type\s+)?[^\n]*from '@crm-forsage\/shared'/gm)) {
        if (match[1]) continue // import type — зникає при компіляції, це безпечно
        offenders.push(path.relative(path.dirname(serverSrc), file))
      }
    }

    expect(
      offenders,
      'пакет shared віддає сирий TypeScript — зібраний сервер його не запустить',
    ).toEqual([])
  })
})
