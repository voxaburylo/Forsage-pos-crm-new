import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  desktop: true, session: null as any, createClient: vi.fn(), login: vi.fn(), attach: vi.fn(), setSession: vi.fn(),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: fixture.createClient }))
vi.mock('./supabase', () => ({ supabase: { auth: { setSession: fixture.attach } } }))
vi.mock('./desktopBridge', () => ({ isDesktopRuntime: () => fixture.desktop }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: fixture.session, setSession: fixture.setSession }) } }))
import { reconnectDesktopServer } from './desktopServerConnection'
const local = () => ({ user: { id: 'cashier', email: 'fixture@forsage.internal', app_metadata: { tenant_id: 'shop', role: 'cashier' } }, access_token: 'local' })
const remote = () => ({ ...local(), access_token: 'remote', refresh_token: 'refresh' })
beforeEach(() => {
  vi.resetAllMocks(); fixture.desktop = true; fixture.session = local()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://fixture.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-public')
  fixture.createClient.mockReturnValue({ auth: { signInWithPassword: fixture.login } })
  fixture.login.mockResolvedValue({ data: { session: remote() }, error: null })
  fixture.attach.mockResolvedValue({ data: { session: remote() }, error: null })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('server connection after local PIN', () => {
  it('keeps credentials in a separate nonpersistent client and attaches only the current employee', async () => {
    await reconnectDesktopServer('entered-secret')
    expect(fixture.login).toHaveBeenCalledWith({ email: 'fixture@forsage.internal', password: 'entered-secret' })
    expect(fixture.createClient.mock.calls[0][2].auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false })
    expect(fixture.attach).toHaveBeenCalledWith({ access_token: 'remote', refresh_token: 'refresh' })
    expect(fixture.setSession).toHaveBeenCalledOnce()
    expect(fixture.session.access_token).toBe('local')
  })
  it.each(['web', 'signed-out', 'no-tenant', 'no-email', 'no-config', 'empty-password'])('rejects %s before sending credentials', async reason => {
    if (reason === 'web') fixture.desktop = false
    if (reason === 'signed-out') fixture.session = null
    if (reason === 'no-tenant') delete fixture.session.user.app_metadata.tenant_id
    if (reason === 'no-email') delete fixture.session.user.email
    if (reason === 'no-config') vi.stubEnv('VITE_SUPABASE_URL', '')
    await expect(reconnectDesktopServer(reason === 'empty-password' ? ' ' : 'entered')).rejects.toThrow()
    expect(fixture.login).not.toHaveBeenCalled()
    expect(fixture.attach).not.toHaveBeenCalled()
  })
  it.each(['other-user', 'other-shop', 'inactive', 'deleted', 'no-login', 'tire-worker', 'missing-session'])('does not attach %s', async reason => {
    const session = remote()
    if (reason === 'other-user') session.user.id = 'other'
    if (reason === 'other-shop') session.user.app_metadata.tenant_id = 'other'
    if (reason === 'inactive') Object.assign(session.user.app_metadata, { is_active: false })
    if (reason === 'deleted') Object.assign(session.user.app_metadata, { deleted_at: 'now' })
    if (reason === 'no-login') Object.assign(session.user.app_metadata, { can_login: false })
    if (reason === 'tire-worker') session.user.app_metadata.role = 'tire_worker'
    fixture.login.mockResolvedValue({ data: { session: reason === 'missing-session' ? null : session }, error: null })
    await expect(reconnectDesktopServer('entered')).rejects.toThrow()
    expect(fixture.attach).not.toHaveBeenCalled()
    expect(fixture.setSession).not.toHaveBeenCalled()
  })
  it('wrong password preserves local login and does not publish raw provider errors', async () => {
    fixture.login.mockResolvedValue({ data: {}, error: { status: 400, message: 'private fixture secret', code: 'invalid_credentials' } })
    await expect(reconnectDesktopServer('entered')).rejects.toThrow('Сервер не прийняв пароль')
    expect(fixture.setSession).not.toHaveBeenCalled(); expect(fixture.session.user.id).toBe('cashier')
  })
  it('rejects double connection and discards a response after the account changes', async () => {
    let finish!: (value: unknown) => void
    fixture.login.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = reconnectDesktopServer('entered')
    const rejected = expect(pending).rejects.toThrow('Акаунт змінився')
    await Promise.resolve()
    await expect(reconnectDesktopServer('again')).rejects.toThrow('вже виконується')
    fixture.session = local() // even the same ID in a new local session invalidates this attempt
    finish({ data: { session: remote() }, error: null })
    await rejected
    expect(fixture.attach).not.toHaveBeenCalled()
  })
  it('unmount aborts connection and discards a late provider response', async () => {
    let finish!: (value: unknown) => void
    fixture.login.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = reconnectDesktopServer('entered', controller.signal)
    const rejected = expect(pending).rejects.toThrow('скасовано')
    await Promise.resolve(); controller.abort(); await rejected
    finish({ data: { session: remote() }, error: null })
    await Promise.resolve(); await Promise.resolve()
    expect(fixture.attach).not.toHaveBeenCalled()
  })
  it('a stalled provider times out instead of freezing the form', async () => {
    vi.useFakeTimers(); fixture.login.mockReturnValue(new Promise(() => {}))
    const rejected = expect(reconnectDesktopServer('entered')).rejects.toThrow('не відповів вчасно')
    await vi.advanceTimersByTimeAsync(20_001); await rejected
    expect(fixture.attach).not.toHaveBeenCalled()
  })
  it('revalidates an account disabled while the session is attaching', async () => {
    const session = remote(); Object.assign(session.user.app_metadata, { can_login: false })
    fixture.attach.mockResolvedValue({ data: { session }, error: null })
    await expect(reconnectDesktopServer('entered')).rejects.toThrow('доступ акаунта змінився')
    expect(fixture.setSession).not.toHaveBeenCalled()
  })
})
