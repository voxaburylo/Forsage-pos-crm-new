import { supabase } from './supabase'
import { isDesktopRuntime } from './desktopBridge'
import { cacheCredential, verifyOfflineCredential, hasAnyOfflineCredential } from './offlineAuth'
import { useAuthStore } from '@/stores/authStore'

function phoneToEmail(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@forsage.internal`
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

// Розрізняємо «нема мережі» від «невірний пароль»: у офлайн-вхід пускаємо ТІЛЬКИ
// коли це мережева проблема, а не помилкові дані.
function isNetworkFailure(err: unknown): boolean {
  if (!err) return false
  const anyErr = err as { name?: string; status?: number; message?: string }
  if (anyErr.name === 'AuthRetryableFetchError') return true
  if (anyErr.status === 0 || anyErr.status === 503 || anyErr.status === 504) return true
  const msg = (anyErr.message ?? '').toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('timeout') ||
    msg.includes('load failed') ||
    !navigator.onLine
  )
}

const OFFLINE_NO_CACHE_MSG =
  'Немає зв\'язку з сервером і немає збереженого входу на цьому ПК. Один раз увійдіть онлайн — далі працюватиме офлайн.'

async function tryOfflineLogin(email: string, password: string): Promise<import('@supabase/supabase-js').Session> {
  const cached = await verifyOfflineCredential(email, password)
  if (cached) {
    useAuthStore.getState().setOfflineSession(cached)
    return cached
  }
  // Кеш є, але пароль інший → це саме невірний пароль, а не відсутність кешу
  throw new Error(
    hasAnyOfflineCredential()
      ? 'Невірний номер телефону або пароль'
      : OFFLINE_NO_CACHE_MSG,
  )
}

const ONLINE_LOGIN_TIMEOUT_MS = 8_000

// Вхід: онлайн через Supabase, а якщо мережі нема — офлайн за збереженим кешем (desktop).
export async function signIn(phone: string, password: string) {
  const normalized = normalizePhone(phone)
  const email = phoneToEmail(normalized)

  // Мережі явно нема (немає інтерфейсу) → одразу офлайн-вхід, без очікування таймауту.
  if (isDesktopRuntime() && typeof navigator !== 'undefined' && navigator.onLine === false) {
    return tryOfflineLogin(email, password)
  }

  let data: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>['data'] | null = null
  let error: unknown = null
  try {
    // Таймаут, щоб під час поганого зв'язку не «висіти», а швидко перейти в офлайн.
    const result = await Promise.race([
      supabase.auth.signInWithPassword({ email, password }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('LOGIN_TIMEOUT'), { name: 'AuthRetryableFetchError' })), ONLINE_LOGIN_TIMEOUT_MS),
      ),
    ])
    data = result.data
    error = result.error
  } catch (thrown) {
    error = thrown
  }

  if (error) {
    const msg = (error as { message?: string }).message ?? ''
    // Явно невірні дані — не пускаємо в офлайн навіть якщо є кеш
    if (msg.includes('Invalid login credentials') || msg.includes('Email not confirmed')) {
      throw new Error('Невірний номер телефону або пароль')
    }
    if (isDesktopRuntime() && isNetworkFailure(error)) {
      return tryOfflineLogin(email, password)
    }
    throw new Error(msg || 'Помилка входу')
  }

  if (!data?.session) {
    if (isDesktopRuntime()) return tryOfflineLogin(email, password)
    throw new Error('Помилка входу')
  }

  // Успішний онлайн-вхід → кешуємо для майбутньої роботи офлайн (лише desktop)
  if (isDesktopRuntime()) {
    await cacheCredential(email, password, data.session).catch(() => {})
  }
  return data.session
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}
