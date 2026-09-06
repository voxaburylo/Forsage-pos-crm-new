import { isDesktopRuntime } from './desktopBridge'
import { API_BASE_URL } from './apiBaseUrl'

const DEFAULT_API_REQUEST_TIMEOUT_MS = 60_000
const SAFE_API_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const WEB_SESSION_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
])

export function isWebReadOnlyRequest(path: string, method: string | undefined): boolean {
  if (isDesktopRuntime() || SAFE_API_METHODS.has((method ?? 'GET').toUpperCase())) return false
  // Вхід і відновлення сесії потрібні навіть у веб-перегляді. Решта записів
  // належать тільки локальній касі й сервер додатково їх відхиляє.
  return !WEB_SESSION_PATHS.has(path)
}

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
  silent?: boolean   // true = не показувати автоматичний toast
  _retry?: boolean   // внутрішній прапор — запобігає infinite loop при refresh
  timeoutMs?: number // якщо задано — запит переривається через цей час (щоб UI не зависав назавжди)
}

async function getAccessToken(): Promise<string | null> {
  try {
    const { supabase } = await import('./supabase')
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  } catch {
    return null
  }
}

function humanizeApiError(message: string, code?: string): string {
  if (code === 'SKU_DUPLICATE') return message || 'Товар з таким артикулом вже існує'
  if (code === 'BARCODE_TAKEN') return message || 'Товар з таким штрихкодом вже існує'

  const lower = message.toLowerCase()
  if (lower.includes('requested range not satisfiable')) {
    return 'За цим пошуком немає товарів. Очистіть пошук або змініть запит.'
  }
  if (lower.includes('duplicate key') || lower.includes('unique constraint') || lower.includes('already exists')) {
    if (lower.includes('barcode') || lower.includes('штрих')) return 'Товар з таким штрихкодом вже існує'
    if (lower.includes('sku') || lower.includes('артикул')) return 'Товар з таким артикулом вже існує'
    return 'Такий товар вже існує. Перевірте артикул або штрихкод.'
  }
  return message
}

async function refreshToken(): Promise<string | null> {
  try {
    const { supabase } = await import('./supabase')
    const { data, error } = await supabase.auth.refreshSession()
    if (error || !data.session) return null
    return data.session.access_token
  } catch {
    return null
  }
}

export async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  if (isWebReadOnlyRequest(path, options?.method)) {
    const error = new Error('Через веб можна тільки дивитися. Зміни робіть у локальній програмі на касі.')
    ;(error as any).code = 'WEB_IS_READ_ONLY'
    ;(error as any).status = 403
    throw error
  }
  const token = await getAccessToken()
  const { silent, _retry, timeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS, ...fetchOptions } = options ?? {}

  // Кожен серверний запит має межу очікування. Без цього втрачений TCP-запит
  // залишав модальні вікна та розділи у стані «завантаження» без кінця.
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(fetchOptions.signal?.reason)
  if (fetchOptions.signal?.aborted) abortFromCaller()
  else fetchOptions.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1_000, timeoutMs))

  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Каса представляється серверу: зміни приймаються лише від неї. Через
        // веб дані тільки дивляться — щоб не було двох точок запису в одну
        // базу й розбіжностей за ними.
        ...(isDesktopRuntime() ? { 'X-Forsage-Client': 'desktop' } : {}),
        ...fetchOptions.headers,
      },
    })
  } catch (networkErr) {
    const aborted = controller.signal.aborted || (networkErr as any)?.name === 'AbortError'
    const msg = timedOut
      ? 'Сервер не відповів вчасно. Перевірте результат операції перед повторенням.'
      : aborted
        ? 'Запит скасовано.'
        : 'Сервер недоступний. Перевірте підключення до мережі.'
    if (!silent && !isDesktopRuntime()) {
      import('@/components/ui/Toast').then(({ toast }) => toast.error(msg))
    }
    throw new Error(msg)
  } finally {
    clearTimeout(timer)
    fetchOptions.signal?.removeEventListener('abort', abortFromCaller)
  }

  // При 401 — спробуємо оновити токен і повторити запит один раз
  if (res.status === 401 && !_retry) {
    const newToken = await refreshToken()
    if (newToken) {
      return request<T>(path, { ...options, _retry: true })
    }
    // Серверна авторизація не повинна закривати робочу локальну касу.
    // Після відновлення онлайн-сесії фоновий обмін повторить запит.
    if (isDesktopRuntime()) {
      throw new Error('Серверна сесія ще не відновлена. Локальна програма продовжує працювати.')
    }
    // Refresh не вдався — виходимо на логін
    try {
      const { supabase } = await import('./supabase')
      await supabase.auth.signOut()
    } catch { /* ignore */ }
    window.location.href = '/login'
    throw new Error('Сесія закінчилась. Увійдіть знову.')
  }

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`
    let errorCode: string | undefined
    try {
      const body = await res.json()
      errorCode = body?.error?.code
      errorMessage = body?.error?.message ?? errorMessage
      // Технічні префікси кодів із БД-помилок (INSUFFICIENT_STOCK: ...) користувачу не потрібні
      errorMessage = errorMessage.replace(/^[A-Z][A-Z_]{2,}:\s*/, '')
      errorMessage = humanizeApiError(errorMessage, errorCode)
    } catch { /* response не JSON */ }

    if (!silent && !isDesktopRuntime()) {
      import('@/components/ui/Toast').then(({ toast }) => toast.error(errorMessage))
    }
    const err = new Error(errorMessage)
    ;(err as any).status = res.status
    ;(err as any).code = errorCode
    throw err
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get:    <T>(path: string, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, opts),
  post:   <T>(path: string, body: unknown, headers?: Record<string, string>, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'POST',  body: JSON.stringify(body), headers, ...opts }),
  put:    <T>(path: string, body: unknown, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'PUT',   body: JSON.stringify(body), ...opts }),
  patch:  <T>(path: string, body: unknown, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body), ...opts }),
  delete: <T>(path: string, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'DELETE', ...opts }),
}
