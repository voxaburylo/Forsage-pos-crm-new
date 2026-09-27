import { describe, expect, it, vi } from 'vitest'
vi.mock('./desktopBridge', () => ({ isDesktopRuntime: () => true }))
vi.mock('./supabase', () => ({ supabase: { auth: {
  getSession: async () => ({ data: { session: null } }),
  refreshSession: async () => ({ data: { session: null }, error: Error('no session') }),
} } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: 'local' } } }) } }))
import { request } from './api'
describe('missing online session does not mean offline till', () => {
  it('returns a structured reconnect error without navigating out of the local account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    try {
      await expect(request('/api/v1/ai/status', { silent: true })).rejects.toMatchObject({ status: 401, code: 'DESKTOP_SERVER_AUTH_REQUIRED' })
      expect(fetch).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })
})
