import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'
import { desktopBridge, isDesktopRuntime } from './desktopBridge'
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

function isProgramAccessDenied(user: unknown): boolean {
  const metadata = (user as { app_metadata?: Record<string, unknown> } | null | undefined)?.app_metadata
  return metadata?.role === 'tire_worker' || metadata?.can_login === false || metadata?.is_active === false || Boolean(metadata?.deleted_at)
}

// Відрізняємо тимчасову мережеву помилку від помилки облікових даних.
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

const ONLINE_LOGIN_TIMEOUT_MS = 8_000

/**
 * Паузи між спробами підняти серверну сесію після локального входу.
 *
 * Раніше цей список закінчувався — три спроби, приблизно 80 секунд, і каса
 * лишалася в офлайн-режимі до перезапуску. 06.09.2026 це коштувало магазину
 * цілого дня: 31 операція, з них 27 чеків, не поїхала на сервер, і жодної
 * спроби відправки навіть не було — синхронізатор у офлайн-режимі не працює.
 *
 * Тепер список не закінчується: останнє значення повторюється, поки сесія не
 * піднімється. Ранковий Render прокидається 20-25 секунд, інтернет у магазині
 * зникає й повертається — програма мусить дочекатися сама.
 */
const DESKTOP_SERVER_RETRY_MS = [5_000, 15_000, 60_000, 300_000]

/**
 * Пауза перед наступною спробою підняти серверну сесію. Після останнього
 * значення повертає його ж — спроби не закінчуються ніколи.
 */
export function desktopServerRetryDelay(attempt: number): number {
  const index = Math.min(Math.max(0, attempt), DESKTOP_SERVER_RETRY_MS.length - 1)
  return DESKTOP_SERVER_RETRY_MS[index]
}
let desktopServerLoginGeneration = 0
const desktopRetryTimers = new Set<ReturnType<typeof setTimeout>>()
function nextDesktopLoginGeneration() {
  for (const timer of desktopRetryTimers) clearTimeout(timer)
  desktopRetryTimers.clear()
  return ++desktopServerLoginGeneration
}

async function connectDesktopToServer(
  email: string,
  password: string,
  attempt: number,
  generation: number,
): Promise<void> {
  if (generation !== desktopServerLoginGeneration) return

  const retry = () => {
    if (generation !== desktopServerLoginGeneration) return
    const timer = setTimeout(() => {
      desktopRetryTimers.delete(timer)
      void connectDesktopToServer(email, password, attempt + 1, generation)
    }, desktopServerRetryDelay(attempt))
    desktopRetryTimers.add(timer)
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { retry(); return }
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (generation !== desktopServerLoginGeneration) return
    if (error) { if (isNetworkFailure(error)) retry(); return }
    if (!data.session) { retry(); return }
    if (isProgramAccessDenied(data.user)) { await supabase.auth.signOut().catch(() => {}); return }
    const current = useAuthStore.getState().session
    if (!current || current.user.id !== data.session.user.id) return
    useAuthStore.getState().setSession(data.session)
  } catch {
    // Локальний вхід уже успішний: повторюємо серверний вхід у фоні,
    // не блокуючи касу через нестабільну мережу.
    retry()
  }
}

function startDesktopServerConnection(email: string, password: string, generation: number): void {
  void connectDesktopToServer(email, password, 0, generation)
}

function createDesktopSession(user: { id: string; email: string; phone?: string | null; full_name?: string | null; role?: string | null; tenant_id?: string | null }): Session {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: `local-desktop-${user.id}-${now}`,
    refresh_token: `local-desktop-refresh-${user.id}`,
    token_type: 'bearer',
    expires_in: 60 * 60 * 12,
    expires_at: now + 60 * 60 * 12,
    user: {
      id: user.id,
      app_metadata: {
        provider: 'desktop-local',
        providers: ['desktop-local'],
        role: user.role ?? 'cashier',
        tenant_id: user.tenant_id ?? undefined,
        is_active: true,
      },
      user_metadata: {
        role: user.role ?? 'cashier',
        full_name: user.full_name ?? '',
        phone: user.phone ?? '',
        tenant_id: user.tenant_id ?? undefined,
      },
      aud: 'authenticated',
      confirmation_sent_at: undefined,
      recovery_sent_at: undefined,
      email_change_sent_at: undefined,
      new_email: undefined,
      new_phone: undefined,
      invited_at: undefined,
      action_link: undefined,
      email: user.email,
      phone: user.phone ?? '',
      created_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
      phone_confirmed_at: undefined,
      last_sign_in_at: new Date().toISOString(),
      role: 'authenticated',
      updated_at: new Date().toISOString(),
      identities: [],
      factors: null,
    },
  } as unknown as Session
}
// Desktop завжди перевіряє пароль у локальній базі; веб — через Supabase.
export async function signIn(phone: string, password: string) {
  const generation = nextDesktopLoginGeneration()
  const assertCurrent = () => {
    if (generation !== desktopServerLoginGeneration) throw new Error('Спробу входу скасовано')
  }
  const normalized = normalizePhone(phone)
  const email = phoneToEmail(normalized)

  if (isDesktopRuntime()) {
    const desktopAuth = desktopBridge()?.auth
    const localLogin = desktopAuth?.login
    if (localLogin) {
      try {
        const localUser = await localLogin(normalized, password)
        assertCurrent()
        const session = createDesktopSession(localUser)
        useAuthStore.getState().setOfflineSession(session)
        // Локальний пароль перевірено — відкриваємо програму одразу. Паралельно
        // отримуємо справжню Supabase-сесію для синхронізації та веб-розділів.
        startDesktopServerConnection(email, password, generation)
        return session
      } catch (localError) {
        assertCurrent()
        const message = localError instanceof Error ? localError.message : ''
        if (message.includes('Забагато спроб') || /LOCAL_AUTH_(ARCHIVED|DISABLED)/.test(message) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
          throw localError
        }

        // У старій локальній базі пароль міг бути відсутнім. Один раз підтверджуємо
        // його через зафіксований у збірці Supabase-проєкт, після чого зберігаємо
        // тільки захищений хеш і наступні входи знову працюють повністю офлайн.
        const onlineLogin = desktopAuth?.loginOnline
        if (!onlineLogin) throw localError
        const provisioned = await onlineLogin(normalized, password)
        assertCurrent()
        useAuthStore.getState().setOfflineSession(createDesktopSession(provisioned.user))
        const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
          access_token: provisioned.access_token,
          refresh_token: provisioned.refresh_token,
        })
        assertCurrent()
        if (sessionError || !sessionData.session) {
          const session = createDesktopSession(provisioned.user)
          useAuthStore.getState().setOfflineSession(session)
          startDesktopServerConnection(email, password, generation)
          return session
        }
        useAuthStore.getState().setSession(sessionData.session)
        return sessionData.session
      }
    }
  }

  let data: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>['data'] | null = null
  let error: unknown = null
  try {
    // Таймаут не дає веб-входу зависнути при поганому зв'язку.
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
    // Показуємо понятную ошибку вместо ответа Supabase.
    if (msg.includes('Invalid login credentials') || msg.includes('Email not confirmed')) {
      throw new Error('Невірний номер телефону або пароль')
    }
    throw new Error(msg || 'Помилка входу')
  }

  if (!data?.session) throw new Error('Помилка входу')
  if (isProgramAccessDenied(data.user)) {
    await supabase.auth.signOut().catch(() => {})
    throw new Error('Цей працівник не має доступу до програми')
  }

  return data.session
}

let restoreFlight: Promise<Session | null> | null = null
export function restoreDesktopSession(): Promise<Session | null> {
  if (restoreFlight) return restoreFlight
  const restore = desktopBridge()?.auth?.restore
  if (!isDesktopRuntime() || !restore) return Promise.resolve(null)
  const generation = nextDesktopLoginGeneration()
  restoreFlight = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const user = await Promise.race([
        restore(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('RESTORE_TIMEOUT')), 5000) }),
      ])
      if (!user || generation !== desktopServerLoginGeneration) return null
      const session = createDesktopSession(user)
      useAuthStore.getState().setOfflineSession(session)
      // Attach only an already existing matching online session. Passwords are
      // never restored from storage, and local access does not wait for internet.
      void supabase.auth.getSession().then(({ data }) => {
        if (generation === desktopServerLoginGeneration && data.session?.user.id === user.id
          && !isProgramAccessDenied(data.session.user) && useAuthStore.getState().session?.user.id === user.id) {
          useAuthStore.getState().setSession(data.session)
        }
      }).catch(() => {})
      return session
    } finally { if (timeout) clearTimeout(timeout) }
  })().finally(() => { restoreFlight = null })
  return restoreFlight
}

export async function signOut() {
  nextDesktopLoginGeneration()
  const localLogout = desktopBridge()?.auth?.logout
  if (localLogout) {
    // Revoke the encrypted day permission before displaying the login page.
    // Do not report successful logout if main could not remove that permission.
    await localLogout()
    useAuthStore.getState().setSession(null)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        supabase.auth.signOut({ scope: 'local' }).catch(() => {}),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 2000) }),
      ])
    } finally { if (timeout) clearTimeout(timeout) }
    return
  }
  await supabase.auth.signOut({ scope: 'local' })
  useAuthStore.getState().setSession(null)
}

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  if (data.session && isProgramAccessDenied(data.session.user)) {
    await supabase.auth.signOut().catch(() => {})
    return null
  }
  return data.session
}



