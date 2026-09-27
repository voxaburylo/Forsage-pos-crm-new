import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { isDesktopRuntime } from '@/lib/desktopBridge'

interface AuthState {
  session: Session | null
  loading: boolean
  /** true for the in-memory desktop session verified by the local database. */
  offlineMode: boolean
  setSession: (session: Session | null) => void
  setOfflineSession: (session: Session) => void
  setLoading: (loading: boolean) => void
}

// Only main's password verification or valid encrypted day access establishes identity.
// Server reconnects can attach a token, never switch the cashier or log out the till.
let verifiedLocalSession: Session | null = null

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  loading: true,
  offlineMode: false,
  setSession: (session) => {
    if (!session) verifiedLocalSession = null
    if (session && isDesktopRuntime() && !verifiedLocalSession) { set({ loading: false }); return }
    if (session && verifiedLocalSession) {
      if (session.user.id !== verifiedLocalSession.user.id || session.user.app_metadata?.tenant_id !== verifiedLocalSession.user.app_metadata?.tenant_id) return
      session = { ...session, user: { ...session.user, app_metadata: { ...session.user.app_metadata, role: verifiedLocalSession.user.app_metadata.role, tenant_id: verifiedLocalSession.user.app_metadata.tenant_id } } }
    }
    set({ session, offlineMode: false, loading: false })
  },
  setOfflineSession: (session) => { verifiedLocalSession = session; set({ session, offlineMode: true, loading: false }) },
  setLoading: (loading) => set({ loading }),
}))

let trustedClaimsRefreshAttempted = false

supabase.auth.onAuthStateChange((_event, session) => {
  const state = useAuthStore.getState()

  if (verifiedLocalSession) {
    if (!session || session.user.app_metadata?.is_active === false || session.user.app_metadata?.can_login === false || session.user.app_metadata?.deleted_at) {
      state.setOfflineSession(verifiedLocalSession)
      return
    }
    if (session.user.id !== verifiedLocalSession.user.id || session.user.app_metadata?.tenant_id !== verifiedLocalSession.user.app_metadata?.tenant_id) return
  }

  // A temporary Supabase disconnect must not close an already verified local
  // desktop session. Main independently validates today's permission after restart.
  if (!session && state.offlineMode) {
    state.setLoading(false)
    return
  }

  state.setSession(session)
  if (session && !session.user.app_metadata?.tenant_id && !trustedClaimsRefreshAttempted
      && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    trustedClaimsRefreshAttempted = true
    setTimeout(() => { void supabase.auth.refreshSession() }, 0)
  }
})
