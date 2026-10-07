import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const rules = readFileSync(join(root, '.vercelignore'), 'utf8').split(/\r?\n/).map(line => line.trim())
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : []
  })
}

it('includes every desktop source imported by production web code in the deployment context', () => {
  const required = new Set<string>()
  for (const file of sourceFiles(join(root, 'apps/web/src'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+['"]([^'"]*desktop\/src\/[^'"]+)['"]/g)) {
      required.add(relative(root, resolve(dirname(file), match[1]) + '.ts').replaceAll('\\', '/'))
    }
  }
  expect([...required].sort()).toEqual([
    'apps/desktop/src/lib/catalogLanguageSearch.ts',
    'apps/desktop/src/lib/catalogSearchQuery.ts',
  ])
  for (const file of required) {
    expect(rules, file + ' must survive Vercel filtering').toContain('!' + file)
    expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/from\s+['"]/)
  }
})

it('keeps local credentials, database copies and desktop installers out of uploads', () => {
  for (const rule of ['.env*', '*.local', '*.db', '*.exe', 'local-scripts/', '.vercel/']) expect(rules).toContain(rule)
})

it('continues excluding desktop runtime rather than publishing the whole application', () => {
  expect(rules).toContain('apps/desktop/*')
  expect(rules).toContain('apps/desktop/src/*')
  expect(rules).toContain('apps/desktop/src/lib/*')
})
