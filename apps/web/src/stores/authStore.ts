import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { refreshCachedSession } from '@/lib/offlineAuth'

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
  }
  useAuthStore.getState().setLoading(false)
})
