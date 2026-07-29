import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

interface AuthState {
  session: Session | null
  loading: boolean
  /** true for the in-memory desktop session verified by the local database. */
  offlineMode: boolean
  setSession: (session: Session | null) => void
  setOfflineSession: (session: Session) => void
  setLoading: (loading: boolean) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  loading: true,
  offlineMode: false,
  setSession: (session) => set({ session, offlineMode: false, loading: false }),
  setOfflineSession: (session) => set({ session, offlineMode: true, loading: false }),
  setLoading: (loading) => set({ loading }),
}))

let trustedClaimsRefreshAttempted = false

supabase.auth.onAuthStateChange((_event, session) => {
  const state = useAuthStore.getState()

  // A temporary Supabase disconnect must not close an already verified local
  // desktop session. That session exists only in memory and is never restored
  // after the application is restarted.
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