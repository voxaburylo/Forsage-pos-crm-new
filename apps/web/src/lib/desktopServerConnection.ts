import { createClient } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { isDesktopRuntime } from './desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { withRequestDeadline } from './requestDeadline'

let connecting = false

// Reconnect only the already verified local employee. No password storage,
// no local login/logout, no shop data writes, no retry retaining the password.
// authStore asks main to protect the resulting server tokens for the current day.
export async function reconnectDesktopServer(password: string, caller?: AbortSignal): Promise<void> {
  const local = useAuthStore.getState().session
  if (!isDesktopRuntime() || !local?.user?.id || !local.user.email || !local.user.app_metadata?.tenant_id)
    throw new Error('Спочатку увійдіть у локальну програму своїм акаунтом.')
  if (!password.trim()) throw new Error('Введіть пароль акаунта.')
  if (connecting) throw new Error('Підключення вже виконується.')
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('У цій збірці не налаштоване серверне підключення.')
  const unchanged = () => useAuthStore.getState().session === local
  connecting = true
  try {
    const session = await withRequestDeadline(async signal => {
      // Isolated auth client prevents a late response from switching global identity.
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
      })
      const { data, error } = await client.auth.signInWithPassword({ email: local.user.email!, password })
      signal.throwIfAborted()
      if (!unchanged()) throw new Error('Акаунт змінився. Підключіть ШІ з поточного акаунта.')
      if (error) {
        if (error.status === 429) throw new Error('Забагато спроб входу. Зачекайте та спробуйте ще раз.')
        if (error.code === 'invalid_credentials' || error.status === 400)
          throw new Error('Сервер не прийняв пароль цього акаунта. Якщо пароль змінювали лише локально, зверніться до власника.')
        throw new Error('Не вдалося підключитися до сервера авторизації. Спробуйте ще раз.')
      }
      const remote = data.session
      const meta = remote?.user.app_metadata
      if (!remote || remote.user.id !== local.user.id || meta?.tenant_id !== local.user.app_metadata.tenant_id)
        throw new Error('Серверний акаунт не відповідає поточному працівнику або магазину. Зверніться до власника.')
      if (meta.is_active === false || meta.can_login === false || meta.deleted_at || meta.role === 'tire_worker')
        throw new Error('Серверний доступ цього працівника вимкнено. Локальна каса залишається відкритою.')
      return remote
    }, 20_000, caller)
    caller?.throwIfAborted()
    if (!unchanged()) throw new Error('Акаунт змінився. Підключіть ШІ з поточного акаунта.')
    const attached = await withRequestDeadline(() => supabase.auth.setSession({
      access_token: session.access_token, refresh_token: session.refresh_token,
    }), 15_000, caller)
    if (attached.error || !attached.data.session) throw new Error('Не вдалося відновити серверний сеанс. Спробуйте ще раз.')
    // authStore independently preserves the local employee, tenant and local role.
    const current = useAuthStore.getState().session
    if (current?.user.id !== local.user.id || current.user.app_metadata?.tenant_id !== local.user.app_metadata.tenant_id)
      throw new Error('Акаунт змінився. Локальний вхід не змінено.')
    const remote = attached.data.session.user
    const meta = remote.app_metadata
    if (remote.id !== local.user.id || meta?.tenant_id !== local.user.app_metadata.tenant_id
      || meta.is_active === false || meta.can_login === false || meta.deleted_at || meta.role === 'tire_worker')
      throw new Error('Серверний доступ акаунта змінився. Локальний вхід не змінено.')
    useAuthStore.getState().setSession(attached.data.session)
  } finally { connecting = false }
}
