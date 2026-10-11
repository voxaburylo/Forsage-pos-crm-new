import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it.each([
  ['/', '', ''],
  ['./', '', 'https://forsage-pos-crm-new-web.vercel.app'],
  ['/', 'https://forsage-pos-crm-new.onrender.com', ''],
  ['./', 'https://forsage-pos-crm-new.onrender.com', 'https://forsage-pos-crm-new-web.vercel.app'],
  ['/', 'invalid address', ''],
  ['./', 'invalid address', 'https://forsage-pos-crm-new-web.vercel.app'],
  ['/', ' https://api.example.test/ ', 'https://api.example.test'],
])('selects a compatible API for base %s and configured %s', async (base, configured, expected) => {
  vi.stubEnv('BASE_URL', base)
  vi.stubEnv('VITE_API_URL', configured)
  expect((await import('./apiBaseUrl')).API_BASE_URL).toBe(expected)
})

it('keeps Vercel API requests on the current production or preview origin', () => {
  const config = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8'))
  expect(config.build.env.VITE_API_URL).toBe('')
})
