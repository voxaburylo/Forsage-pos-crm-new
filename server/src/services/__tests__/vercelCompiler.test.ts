import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))
describe('web API compiler configuration', () => {
  it('explicitly keeps server semantics in the Vercel entrypoint', () => {
    const api = readJson('../../../../api/tsconfig.json')
    const server = readJson('../../../tsconfig.json')
    // The runtime builder applies defaults before resolving extends, so an
    // inherited strict:true alone does not override its strict:false default.
    for (const option of ['target', 'module', 'moduleResolution', 'strict', 'esModuleInterop']) {
      expect(api.compilerOptions[option]).toEqual(server.compilerOptions[option])
    }
    expect(api.compilerOptions.noEmitOnError).toBe(true)
    expect(api.include).toContain('../server/src/types/*.d.ts')
  })
  it('checks the deployment entrypoint in the normal verification command', () => {
    const scripts = readJson('../../../../package.json').scripts
    expect(scripts.typecheck).toContain('pnpm typecheck:api')
    expect(scripts['typecheck:api']).toContain('../api/tsconfig.json')
  })
})
