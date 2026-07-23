import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { refreshCachedSession, loadLastCachedSession } from '@/lib/offlineAuth'
import { isDesktopRuntime } from '@/lib/desktopBridge'

interface AuthState {
  session: Session | null
  loading: boolean
  /** true, коли сесію відновлено з офлайн-кешу (без підтвердження від Supabase). */
  offlineMode: boolean
  setSession: (session: Session | null) => void
  setOfflineSession: (session: Session) => void
  setLoading: (loading: boolean) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  loading: true,
  offlineMode: false,
  setSession: (session) => set({ session }),
  setOfflineSession: (session) => set({ session, offlineMode: true, loading: false }),
  setLoading: (loading) => set({ loading }),
}))

let trustedClaimsRefreshAttempted = false

supabase.auth.onAuthStateChange((_event, session) => {
  const state = useAuthStore.getState()

  // Під час відключення інтернету/світла Supabase не може оновити токен і може
  // повідомити про відсутність сесії. Якщо ми зайшли офлайн-входом — НЕ вибиваємо
  // касира на екран логіна, тримаємо офлайн-сесію до відновлення зв'язку.
  if (!session && state.offlineMode) {
    useAuthStore.getState().setLoading(false)
    return
  }

  useAuthStore.getState().setSession(session)
  if (session) {
    // Реальна сесія від Supabase (свіжий вхід або авто-refresh) — виходимо з
    // офлайн-режиму й оновлюємо кеш, щоб наступний офлайн-вхід мав свіжий токен.
    useAuthStore.setState({ offlineMode: false })
    const emailKey = session.user?.email
    if (emailKey) refreshCachedSession(emailKey, session)

    // Після перенесення ролі й tenant_id до захищених app_metadata стара JWT
    // може не містити нові claims. Один фоновий refresh отримує актуальний токен.
    if (!session.user.app_metadata?.tenant_id && !trustedClaimsRefreshAttempted
        && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      trustedClaimsRefreshAttempted = true
      setTimeout(() => { void supabase.auth.refreshSession() }, 0)
    }
  }
  useAuthStore.getState().setLoading(false)
})

// Холодний старт desktop: локальну сесію піднімаємо майже одразу, без очікування сервера.
// Якщо Supabase пізніше поверне справжню сесію, onAuthStateChange вище її підставить.
if (isDesktopRuntime()) {
  setTimeout(() => {
    const state = useAuthStore.getState()
    if (!state.loading || state.session) return
    const cached = loadLastCachedSession()
    if (cached) state.setOfflineSession(cached)
    else state.setLoading(false)
  }, 250)
}

