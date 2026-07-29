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

const DESKTOP_SERVER_RETRY_MS = [5_000, 15_000, 60_000]
let desktopServerLoginGeneration = 0

async function connectDesktopToServer(
  email: string,
  password: string,
  attempt: number,
  generation: number,
): Promise<void> {
  if (generation !== desktopServerLoginGeneration) return

  const retry = () => {
    if (attempt >= DESKTOP_SERVER_RETRY_MS.length) return
    const delay = DESKTOP_SERVER_RETRY_MS[attempt]
    window.setTimeout(() => {
      void connectDesktopToServer(email, password, attempt + 1, generation)
    }, delay)
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { retry(); return }
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (generation !== desktopServerLoginGeneration) return
    if (error) { if (isNetworkFailure(error)) retry(); return }
    if (!data.session) { retry(); return }
    useAuthStore.getState().setSession(data.session)
  } catch {
    // Локальний вхід уже успішний: повторюємо серверний вхід у фоні,
    // не блокуючи касу через нестабільну мережу.
    retry()
  }
}

function startDesktopServerConnection(email: string, password: string): void {
  const generation = ++desktopServerLoginGeneration
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
  const normalized = normalizePhone(phone)
  const email = phoneToEmail(normalized)

  if (isDesktopRuntime()) {
    const desktopAuth = desktopBridge()?.auth
    const localLogin = desktopAuth?.login
    if (localLogin) {
      try {
        const localUser = await localLogin(normalized, password)
        const session = createDesktopSession(localUser)
        useAuthStore.getState().setOfflineSession(session)
        // Локальний пароль перевірено — відкриваємо програму одразу. Паралельно
        // отримуємо справжню Supabase-сесію для синхронізації та веб-розділів.
        startDesktopServerConnection(email, password)
        return session
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : ''
        if (message.includes('Забагато спроб') || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
          throw localError
        }

        // У старій локальній базі пароль міг бути відсутнім. Один раз підтверджуємо
        // його через зафіксований у збірці Supabase-проєкт, після чого зберігаємо
        // тільки захищений хеш і наступні входи знову працюють повністю офлайн.
        const onlineLogin = desktopAuth?.loginOnline
        if (!onlineLogin) throw localError
        const provisioned = await onlineLogin(normalized, password)
        const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
          access_token: provisioned.access_token,
          refresh_token: provisioned.refresh_token,
        })
        if (sessionError || !sessionData.session) {
          const session = createDesktopSession(provisioned.user)
          useAuthStore.getState().setOfflineSession(session)
          startDesktopServerConnection(email, password)
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

  return data.session
}

export async function signOut() {
  // Відкладена спроба від попереднього локального входу не повинна знову
  // авторизувати користувача після виходу або зміни касира.
  desktopServerLoginGeneration += 1
  const localLogout = desktopBridge()?.auth?.logout
  if (localLogout) await localLogout().catch(() => {})
  await supabase.auth.signOut()
}

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}



