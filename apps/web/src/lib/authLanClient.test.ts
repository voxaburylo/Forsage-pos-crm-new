import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  status: vi.fn(), login: vi.fn(), loginOnline: vi.fn(), restore: vi.fn(), logout: vi.fn(),
  remoteLogin: vi.fn(), remoteGet: vi.fn(), remoteOut: vi.fn(), remoteSet: vi.fn(),
  offline: vi.fn(), session: null as any, desktop: true,
}))
vi.mock('./supabase', () => ({ supabase: { auth: { signInWithPassword: fixture.remoteLogin, getSession: fixture.remoteGet, signOut: fixture.remoteOut, setSession: fixture.remoteSet } } }))
vi.mock('./desktopBridge', () => ({ isDesktopRuntime: () => fixture.desktop, desktopBridge: () => fixture.desktop ? {
  lan: { firstRunStatus: fixture.status }, auth: { login: fixture.login, loginOnline: fixture.loginOnline, restore: fixture.restore, logout: fixture.logout },
} : undefined }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: fixture.session, setOfflineSession: fixture.offline, setSession: (value: unknown) => { fixture.session = value } }) } }))
const user = { id: 'lan-worker', role: 'manager', tenant_id: 'shop', phone: '+380671111111', email: '380671111111@forsage.internal', full_name: 'LAN Worker' }
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); fixture.desktop = true; fixture.session = null
  vi.stubGlobal('navigator', { onLine: true })
  fixture.status.mockResolvedValue({ mode: 'client', configured: true, canPair: false })
  fixture.login.mockResolvedValue(user); fixture.restore.mockResolvedValue(user); fixture.logout.mockResolvedValue({ success: true })
  fixture.remoteLogin.mockResolvedValue({ data: { session: null }, error: null }); fixture.remoteGet.mockResolvedValue({ data: { session: null } }); fixture.remoteOut.mockResolvedValue({ error: null })
  fixture.offline.mockImplementation(value => { fixture.session = value })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
function expectNoCloud() {
  expect(fixture.remoteLogin).not.toHaveBeenCalled(); expect(fixture.remoteGet).not.toHaveBeenCalled()
  expect(fixture.remoteSet).not.toHaveBeenCalled(); expect(fixture.loginOnline).not.toHaveBeenCalled()
}
it('LAN password login establishes only the locally verified session and schedules no internet retries', async () => {
  const { signIn } = await import('./auth')
  expect((await signIn('0671111111', 'local-password')).user.id).toBe(user.id)
  expect(fixture.login).toHaveBeenCalledWith(user.phone, 'local-password'); expect(fixture.offline).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(3600000); expectNoCloud(); expect(vi.getTimerCount()).toBe(0)
})
it('wrong LAN password never falls back to Supabase or online provisioning', async () => {
  const { signIn } = await import('./auth'); fixture.login.mockRejectedValue(Error('Невірний пароль головного ПК'))
  await expect(signIn(user.phone, 'wrong')).rejects.toThrow('Невірний пароль головного ПК')
  expectNoCloud(); expect(fixture.offline).not.toHaveBeenCalled()
})
it('LAN remembered session restore never reads Supabase tokens', async () => {
  const { restoreDesktopSession } = await import('./auth')
  expect((await restoreDesktopSession())?.user.id).toBe(user.id)
  await vi.runAllTimersAsync(); expectNoCloud()
})
it('LAN getSession reads only the current locally verified session, never cloud identity', async () => {
  const { signIn, getSession } = await import('./auth')
  const local = await signIn(user.phone, 'password')
  expect(await getSession()).toBe(local); expectNoCloud()
})
it('LAN logout revokes local permission and does not contact internet', async () => {
  const { signIn, signOut } = await import('./auth')
  await signIn(user.phone, 'password'); await signOut()
  expect(fixture.logout).toHaveBeenCalledOnce(); expect(fixture.session).toBeNull(); expectNoCloud(); expect(fixture.remoteOut).not.toHaveBeenCalled()
})
it.each([
  { mode: 'standalone', configured: false, canPair: true },
  { mode: 'client', configured: false, canPair: false },
])('unpaired or damaged client configuration cannot fall through to cloud login: %j', async status => {
  const { signIn } = await import('./auth'); fixture.status.mockResolvedValue(status)
  await expect(signIn(user.phone, 'password')).rejects.toThrow(/підключення/)
  expect(fixture.login).not.toHaveBeenCalled(); expectNoCloud()
})
it('status failure fails closed instead of guessing this is the main PC', async () => {
  const { signIn } = await import('./auth'); fixture.status.mockRejectedValue(Error('IPC unavailable'))
  await expect(signIn(user.phone, 'password')).rejects.toThrow(/перевірити/)
  expect(fixture.login).not.toHaveBeenCalled(); expectNoCloud()
})
it('existing main PC retains local-first login and background cloud connection', async () => {
  const { signIn } = await import('./auth'); fixture.status.mockResolvedValue({ mode: 'hub', configured: true, canPair: false })
  expect((await signIn(user.phone, 'password')).user.id).toBe(user.id)
  expect(fixture.remoteLogin).toHaveBeenCalledOnce()
})
