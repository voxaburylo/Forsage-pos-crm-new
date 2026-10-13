import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ read: vi.fn(), present: true, desktop: true }))
vi.mock('./desktopBridge', () => ({ isDesktopRuntime: () => fixture.desktop, desktopBridge: () => fixture.present ? { lan: { firstRunStatus: fixture.read } } : undefined }))
import { canUseCloudBackground, lanNeedsSetup, lanPairInput, normalizeDiscoveredHubs, readLanFirstRunStatus } from './lanFirstRun'
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); fixture.present = true; fixture.desktop = true })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
it('old bridge retains existing login, but current API errors cannot impersonate main PC', async () => {
  fixture.present = false; expect(await readLanFirstRunStatus()).toBeNull()
  fixture.present = true; fixture.read.mockRejectedValue(Error('IPC failed'))
  await expect(readLanFirstRunStatus()).rejects.toThrow('хмарний вхід не запускався')
})
it('public status returns only safe fields and releases timeout', async () => {
  fixture.read.mockResolvedValue({ mode: 'client', configured: true, canPair: false, accessKey: 'never-copy-this' })
  expect(await readLanFirstRunStatus()).toEqual({ mode: 'client', configured: true, canPair: false })
  expect(vi.getTimerCount()).toBe(0)
})
it.each([null, { mode: 'other', configured: true, canPair: false }, { mode: 'client', configured: 'true', canPair: false }, { mode: 'standalone', configured: false }])('rejects malformed status %j', async value => {
  fixture.read.mockResolvedValue(value); await expect(readLanFirstRunStatus()).rejects.toThrow('перевірити підключення')
})
it('stuck status read times out rather than hanging login or enabling cloud fallback', async () => {
  fixture.read.mockReturnValue(new Promise(() => {}))
  const pending = expect(readLanFirstRunStatus()).rejects.toThrow('перевірити підключення')
  await vi.advanceTimersByTimeAsync(5000); await pending; expect(vi.getTimerCount()).toBe(0)
})
it('setup is only fresh allowed pairing or damaged client configuration, not network availability', () => {
  expect(lanNeedsSetup(null)).toBe(false)
  expect(lanNeedsSetup({ mode: 'hub', canPair: false, configured: true })).toBe(false)
  expect(lanNeedsSetup({ mode: 'client', canPair: false, configured: true })).toBe(false)
  expect(lanNeedsSetup({ mode: 'standalone', canPair: true, configured: false })).toBe(true)
  expect(lanNeedsSetup({ mode: 'client', canPair: false, configured: false })).toBe(true)
})
it('discovery filters malformed duplicates and does not copy secret metadata', () => {
  expect(normalizeDiscoveredHubs([{ address: ' 192.168.1.2 ', name: 'Hub', accessKey: 'secret' }, { address: '192.168.1.2', name: 'Duplicate' }, { address: '', name: 'Bad' }, null, { address: '192.168.1.3', name: '' }])).toEqual([{ address: '192.168.1.2', name: 'Hub' }, { address: '192.168.1.3', name: 'Головний ПК' }])
})
it('pair input preserves explicit host/port, trims code, and never supplies an implicit store', () => {
  expect(lanPairInput(' 192.168.1.2 ', ' code ', '')).toEqual({ hubAddress: '192.168.1.2', accessKey: 'code' })
  expect(lanPairInput('http://192.168.1.2', 'code', '3210')).toEqual({ hubAddress: 'http://192.168.1.2', accessKey: 'code', port: 3210 })
})
it.each(['0', '999', '65536', '1234.5', 'port'])('rejects invalid port %s', port => {
  expect(() => lanPairInput('192.168.1.2', 'code', port)).toThrow('Порт')
})
it('requires both address and code', () => {
  expect(() => lanPairInput('', 'code', '')).toThrow('адресу')
  expect(() => lanPairInput('192.168.1.2', '', '')).toThrow('код')
})
it.each([
  [{ mode: 'client', canPair: false, configured: true }, false],
  [{ mode: 'client', canPair: false, configured: false }, false],
  [{ mode: 'standalone', canPair: true, configured: false }, false],
  [{ mode: 'standalone', canPair: false, configured: false }, true],
  [{ mode: 'hub', canPair: false, configured: false }, true],
])('cloud background permission follows verified device ownership: %j', async (status, allowed) => {
  fixture.read.mockResolvedValue(status); expect(await canUseCloudBackground()).toBe(allowed)
})
it('cloud background fails closed on unknown desktop mode, but does not alter browser behavior', async () => {
  fixture.read.mockRejectedValue(Error('IPC failed')); expect(await canUseCloudBackground()).toBe(false)
  fixture.desktop = false; fixture.read.mockClear(); expect(await canUseCloudBackground()).toBe(true)
  expect(fixture.read).not.toHaveBeenCalled()
})
