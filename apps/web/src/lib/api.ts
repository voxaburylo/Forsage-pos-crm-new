import { withRequestDeadline } from './requestDeadline'
import { isDesktopRuntime } from './desktopBridge'
import { API_BASE_URL } from './apiBaseUrl'
import { apiValidationError } from './apiValidationError'

const DEFAULT_API_REQUEST_TIMEOUT_MS = 60_000
const SAFE_API_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const WEB_SESSION_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
])

/**
 * Єдиний запис, дозволений з вебу: команда на касу. Вона нічого не змінює на сервері —
 * зміну виконує програма на касі у своїй базі (або команда згорає за 30 с).
 */
const WEB_TILL_COMMAND_PATH = '/api/v1/till-commands'
/** Розпізнавання фото накладної з телефона: лише читає фото; рядки далі їдуть на касу командою. */
const WEB_INVOICE_PHOTO_PATH = '/api/v1/ai/supply-invoice-photo'
/** 22.11.2026: запит вебу до головного ПК — виконує каса у своїй базі. */
const WEB_TILL_RPC_PATH = '/api/v1/till-rpc'
/** 22.11.2026: ШІ-помічник у вебі — розмова й пропозиції лише читають; дію застосовує головний ПК. */
// 22.11.2026: пошук фото товару й читання VIN з фото теж лише читають.
const WEB_AI_READ_PATHS = new Set(['/api/v1/ai/chat', '/api/v1/ai/catalog-review', '/api/v1/ai/product-photos', '/api/v1/vin/ocr'])
const WEB_AI_MEMORY_PATH = '/api/v1/ai/memory'
/** 22.11.2026: дані лише на сервері (у касі їх немає) — змінювати можна й з вебу. */
// Посилання на прайс, групи клієнтів і підключення бота власника теж живуть лише на сервері.
const SERVER_ONLY_DATA_PREFIXES = ['/api/v1/waitlist/', '/api/v1/notifications/', '/api/v1/channels', '/api/v1/chats/', '/api/v1/settings/owner-alerts',
  '/api/v1/price-links', '/api/v1/customer-groups', '/api/v1/settings/telegram-connect']

export function isWebReadOnlyRequest(path: string, method: string | undefined): boolean {
  if (isDesktopRuntime() || SAFE_API_METHODS.has((method ?? 'GET').toUpperCase())) return false
  if ((path === WEB_TILL_COMMAND_PATH || path === WEB_INVOICE_PHOTO_PATH || path === WEB_TILL_RPC_PATH) && (method ?? '').toUpperCase() === 'POST') return false
  const verb = (method ?? '').toUpperCase()
  // 22.11.2026: PIN і пароль працівника — із вебу навіть без головного ПК; касі сервер передає лише хеш.
  if ((verb === 'POST' && path === '/api/v1/auth/set-pin') || (verb === 'PUT' && /^\/api\/v1\/admin\/users\/[0-9a-f-]{36}\/password$/.test(path))) return false
  if (SERVER_ONLY_DATA_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) return false
  if (verb === 'POST' && WEB_AI_READ_PATHS.has(path)) return false
  if ((verb === 'POST' && path === WEB_AI_MEMORY_PATH) || (verb === 'DELETE' && path.startsWith(WEB_AI_MEMORY_PATH + '/'))) return false
  // Вхід і відновлення сесії потрібні навіть у веб-перегляді. Решта записів
  // належать тільки локальній касі й сервер додатково їх відхиляє.
  return !WEB_SESSION_PATHS.has(path)
}

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
  silent?: boolean   // true = не показувати автоматичний toast
  _retry?: boolean   // внутрішній прапор — запобігає infinite loop при refresh
  timeoutMs?: number // якщо задано — запит переривається через цей час (щоб UI не зависав назавжди)
  /** Рядки ходу роботи ШІ (NDJSON); без нього відповідь читається як звичайний JSON. */
  onProgressLine?: (event: unknown) => void
}

async function getAccessToken(): Promise<string | null> {
  try {
    const { supabase } = await import('./supabase')
    let { data } = await supabase.auth.getSession()
    if (isDesktopRuntime()) {
      const { useAuthStore } = await import('@/stores/authStore')
      const local = useAuthStore.getState().session
      if (!data.session && local?.user.app_metadata?.tenant_id) {
        const { restoreDesktopServerSession } = await import('./desktopServerSession')
        await restoreDesktopServerSession(local, () => useAuthStore.getState().session === local)
        data = (await supabase.auth.getSession()).data
      }
      const current = useAuthStore.getState().session
      if (!data.session || data.session.user.id !== current?.user.id || data.session.user.app_metadata?.tenant_id !== current?.user.app_metadata?.tenant_id) return null
    }
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
    if (isDesktopRuntime()) {
      const { useAuthStore } = await import('@/stores/authStore')
      const local = useAuthStore.getState().session
      if (data.session.user.id !== local?.user.id || data.session.user.app_metadata?.tenant_id !== local?.user.app_metadata?.tenant_id) return null
    }
    return data.session.access_token
  } catch {
    return null
  }
}

/**
 * 21.11.2026: відповідь ШІ рядками — спершу хід роботи ({progress}), наприкінці {data} або {error}.
 * Помилка в потоці кидається так само, як звичайна помилка API.
 */
export async function readNdjsonResponse<T>(body: ReadableStream<Uint8Array>, onProgress: (event: unknown) => void, path = ''): Promise<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (line: string): T | undefined => {
    if (!line.trim()) return undefined
    const parsed = JSON.parse(line) as { progress?: unknown; data?: unknown; error?: { code?: string; message?: string; status?: number } }
    if (parsed.progress !== undefined) { onProgress(parsed.progress); return undefined }
    if (parsed.error) {
      const message = humanizeApiError(apiValidationError(path, parsed.error.message ?? 'Помилка ШІ', parsed.error.code, undefined), parsed.error.code)
      throw Object.assign(new Error(message), { status: parsed.error.status ?? 500, code: parsed.error.code })
    }
    return parsed as T
  }
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const result = handle(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (result !== undefined) return result
    }
    if (done) break
  }
  const last = handle(buffer)
  if (last !== undefined) return last
  throw new Error('Відповідь ШІ обірвалась. Повторіть запит; зміни не застосовано.')
}

export function request<T>(path: string, options?: RequestOptions): Promise<T> {
  return withRequestDeadline(signal => requestOnce<T>(path, { ...options, signal }),
    options?.timeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS, options?.signal)
}

import { assistantThroughMainPc } from './assistantViaMainPc'

async function requestOnce<T>(path: string, options?: RequestOptions): Promise<T> {
  if (isWebReadOnlyRequest(path, options?.method)) {
    const error = new Error('Через веб можна тільки дивитися. Зміни робіть у локальній програмі на касі.')
    ;(error as any).code = 'WEB_IS_READ_ONLY'
    ;(error as any).status = 403
    throw error
  }
  const token = await getAccessToken()
  options?.signal?.throwIfAborted()
  const { silent, _retry, ...fetchOptions } = options ?? {}
  delete fetchOptions.onProgressLine
  delete fetchOptions.timeoutMs

  // 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): на головному ПК працівник входить локальним паролем чи PIN
  // і серверної сесії не має — запит помічника йде ключем самого ПК (lib/assistantViaMainPc), без другого пароля.
  const viaMainPcFirst = token ? null : await assistantThroughMainPc(path, fetchOptions.method, fetchOptions.body)
  options?.signal?.throwIfAborted()
  let res: Response
  if (viaMainPcFirst) res = viaMainPcFirst
  else try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchOptions,
      signal: fetchOptions.signal,
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
    const aborted = fetchOptions.signal?.aborted || (networkErr as any)?.name === 'AbortError'
    const msg = aborted
        ? 'Запит скасовано.'
        : 'Сервер недоступний. Перевірте підключення до мережі.'
    if (!silent && !isDesktopRuntime()) {
      import('@/components/ui/Toast').then(({ toast }) => toast.error(msg))
    }
    throw new Error(msg)
  }

  // При 401 — спробуємо оновити токен і повторити запит один раз
  if (res.status === 401 && !_retry) {
    const newToken = await refreshToken()
    options?.signal?.throwIfAborted()
    if (newToken) {
      return requestOnce<T>(path, { ...options, _retry: true })
    }
    // Серверна авторизація не повинна закривати робочу локальну касу.
    // Після відновлення онлайн-сесії фоновий обмін повторить запит.
    if (isDesktopRuntime()) {
      // Сесія була, але сервер її вже не приймає — помічник іде ключем ПК; решта запитів чекає відновлення сесії.
      const viaMainPc = viaMainPcFirst ? null : await assistantThroughMainPc(path, fetchOptions.method, fetchOptions.body)
      options?.signal?.throwIfAborted()
      if (!viaMainPc) {
        throw Object.assign(new Error('Серверна сесія ще не відновлена. Локальна програма продовжує працювати.'), {
          status: 401, code: 'DESKTOP_SERVER_AUTH_REQUIRED',
        })
      }
      res = viaMainPc
    } else {
      // Refresh не вдався — виходимо на логін
      try {
        const { supabase } = await import('./supabase')
        await supabase.auth.signOut()
      } catch { /* ignore */ }
      window.location.href = '/login'
      throw new Error('Сесія закінчилась. Увійдіть знову.')
    }
  }

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`
    let errorCode: string | undefined
    try {
      const body = await res.json()
      errorCode = body?.error?.code
      errorMessage = body?.error?.message ?? errorMessage
      errorMessage = apiValidationError(path, errorMessage, errorCode, body?.error?.details)
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

  if (options?.onProgressLine && (res.headers.get('content-type') ?? '').includes('application/x-ndjson') && res.body) {
    return readNdjsonResponse<T>(res.body, options.onProgressLine, path)
  }
  if (res.status === 204) return undefined as T
  try {
    return await res.json()
  } catch (cause) {
    options?.signal?.throwIfAborted()
    if (/^\/api\/v1\/sync\/(?:changes|bootstrap)(?:\?|$)/.test(path)) {
      throw Object.assign(new Error('Копію даних отримано не повністю. Повторіть завантаження; неповну відповідь не застосовано.'), {
        code: 'SYNC_RESPONSE_INCOMPLETE', cause,
      })
    }
    throw cause
  }
}

export const api = {
  get:    <T>(path: string, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, opts),
  post:   <T>(path: string, body: unknown, headers?: Record<string, string>, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs' | 'onProgressLine'>) => request<T>(path, { method: 'POST',  body: JSON.stringify(body), headers, ...opts }),
  put:    <T>(path: string, body: unknown, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'PUT',   body: JSON.stringify(body), ...opts }),
  patch:  <T>(path: string, body: unknown, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body), ...opts }),
  delete: <T>(path: string, opts?: Pick<RequestOptions, 'silent' | 'timeoutMs'>) => request<T>(path, { method: 'DELETE', ...opts }),
}
