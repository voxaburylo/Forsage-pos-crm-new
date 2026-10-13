import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkCleanupCapability, cleanupCartBlockers } from '../src/security/catalogCleanupSafety'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { isLanProxyChannel } from '../src/lan/localNetwork'
afterEach(() => { vi.useRealTimers() })
it('rechecks the live renderer session and daily lease instead of accepting stale IPC context', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const source = main.slice(main.indexOf('function cleanupSession()'), main.indexOf('function assertCleanupSession('))
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const invoke = new Function('requireDesktopSession', 'localNetwork', 'desktopLoginGeneration', 'desktopAuthSession', 'rememberedSessionRequired', 'rememberedStatus', code + '; return cleanupSession()')
  const owner = { id: 'owner', tenant_id: 'tenant', role: 'owner' }
  const context = () => owner
  expect(() => invoke(context, null, 1, null, false, () => ({ locked: false }))).toThrow()
  expect(() => invoke(context, null, 1, { ...owner, id: 'other' }, false, () => ({ locked: false }))).toThrow()
  expect(() => invoke(context, null, 1, owner, true, () => ({ locked: true }))).toThrow()
  expect(invoke(context, null, 1, owner, true, () => ({ locked: false }))).toEqual({ ...owner, generation: 1 })
})
it('allows only owners/admins on the primary computer', () => {
  for (const mode of ['scan', 'preview', 'apply', 'apply-sku']) {
    const channel = 'desktop:catalog:cleanup-' + mode
    expect(isDesktopChannelAllowed(channel, 'owner')).toBe(true)
    expect(isDesktopChannelAllowed(channel, 'admin')).toBe(true)
    for (const role of ['manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker']) expect(isDesktopChannelAllowed(channel, role)).toBe(false)
    expect(isLanProxyChannel(channel)).toBe(false)
  }
})
it('requires a verified supported server version and fixed HTTPS origin', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { catalog_cleanup: 1 } })))
  expect(await checkCleanupCapability('https://example.test', 'fixture-token', fetch)).toEqual({ available: true })
  expect(fetch).toHaveBeenCalledWith('https://example.test/api/v1/sync/capabilities', expect.objectContaining({ redirect: 'error' }))
  fetch.mockClear()
  for (const url of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/?query=1']) expect((await checkCleanupCapability(url, 'token', fetch)).available).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})
it.each([{}, { data: { catalog_cleanup: true } }, { data: { catalog_cleanup: 2 } }])('fails closed for older/unknown capabilities', async value => {
  expect((await checkCleanupCapability('https://example.test', 'token', async () => new Response(JSON.stringify(value)))).available).toBe(false)
})
it('does not leak token or provider error', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('SECRET_TOKEN'))
  const result = await checkCleanupCapability('https://example.test', 'SECRET_TOKEN', fetch)
  expect(result.available).toBe(false); expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN')
})
it('checks every persisted cashier scope, including legacy cart', () => {
  const empty = ['forsage_pos_open_receipts_v2:user1', JSON.stringify({ tabs: [] })]
  const occupied = ['forsage_pos_open_receipts_v2:user2', JSON.stringify({ tabs: [{ items: [{ productId: 'source' }] }] })]
  expect(cleanupCartBlockers([empty, occupied], ['source'])).toHaveLength(1)
  expect(cleanupCartBlockers([empty, occupied], ['other'])).toEqual([])
  expect(cleanupCartBlockers([['forsage_pos_cart', JSON.stringify({ product_id: 'source' })]], ['source'])).toHaveLength(1)
})
it.each([null, {}, [['bad-key', '{}']], [['forsage_pos_cart', '{']], [['forsage_pos_cart', null]]])('fails closed on an unreadable cart snapshot', raw => {
  expect(cleanupCartBlockers(raw, ['source'])).toHaveLength(1)
})
it.each(['null', '{}', 'false', '0', '[]', '{"tabs":null}', '{"tabs":[{}]}', '{"tabs":[{"items":[null]}]}'])('rejects parseable but invalid saved receipts: %s', raw => {
  expect(cleanupCartBlockers([['forsage_pos_cart', raw]], ['source'])).toHaveLength(1)
})
