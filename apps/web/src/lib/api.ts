const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

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

// Офлайн-читання: у десктоп-касі GET на відомі розділи обслуговуємо з локальної
// SQLite, щоб програма працювала без інтернету (local-first). Повертає результат
// або undefined, якщо шлях не покрито локально (тоді йдемо на сервер).
async function tryLocalRead<T>(path: string, method: string | undefined): Promise<T | undefined> {
  if (method && method !== 'GET') return undefined
  let bridge: import('./desktopBridge').ForsageDesktopBridge | null = null
  try {
    const mod = await import('./desktopBridge')
    if (!mod.isDesktopRuntime()) return undefined
    bridge = mod.desktopBridge()
  } catch { return undefined }
  const read = bridge?.read
  if (!read) return undefined

  const [rawPath, rawQuery = ''] = path.replace(/^\/api\/v1\//, '').split('?')
  const query: Record<string, string> = {}
  new URLSearchParams(rawQuery).forEach((v, k) => { query[k] = v })

  try {
    if (rawPath === 'customers') return await read.customers(query) as T
    let m = rawPath.match(/^customers\/([^/]+)$/)
    if (m) return (await read.customer(m[1]) ?? { data: null }) as T
    if (rawPath === 'sales') return await read.sales(query) as T
    m = rawPath.match(/^sales\/([^/]+)$/)
    if (m && m[1] !== 'suspended' && m[1] !== 'calculate-price') {
      return (await read.sale(m[1]) ?? { data: null }) as T
    }
    if (rawPath === 'products' && read.products) return await read.products(query) as T
    // /products/{id} — але не /products/search, /products/generate-barcode-only тощо
    m = rawPath.match(/^products\/([0-9a-f-]{16,})$/i)
    if (m && read.product) return (await read.product(m[1]) ?? { data: null }) as T
    if (rawPath === 'suppliers' && read.suppliers) return await read.suppliers(query) as T
    m = rawPath.match(/^suppliers\/([0-9a-f-]{16,})$/i)
    if (m && read.supplier) return (await read.supplier(m[1]) ?? { data: null }) as T
  } catch {
    return undefined // локальна помилка — спробуємо сервер
  }
  return undefined
}

export async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const token = await getAccessToken()
  const { silent, _retry, timeoutMs, ...fetchOptions } = options ?? {}

  // Local-first читання в десктоп-касі: покриті розділи беремо з локальної БД.
  const local = await tryLocalRead<T>(path, fetchOptions.method)
  if (local !== undefined) return local

  // Опціональний таймаут — щоб UI (зокрема вікно оплати) не зависав, якщо сервер не відповідає
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...fetchOptions,
      signal: controller ? controller.signal : fetchOptions.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...fetchOptions.headers,
      },
    })
  } catch (networkErr) {
    const aborted = (networkErr as any)?.name === 'AbortError'
    const msg = aborted
      ? 'Сервер не відповів вчасно. Перевірте результат операції перед повторенням.'
      : 'Сервер недоступний. Перевірте підключення до мережі.'
    if (!silent) {
      import('@/components/ui/Toast').then(({ toast }) => toast.error(msg))
    }
    throw new Error(msg)
  } finally {
    if (timer) clearTimeout(timer)
  }

  // При 401 — спробуємо оновити токен і повторити запит один раз
  if (res.status === 401 && !_retry) {
    const newToken = await refreshToken()
    if (newToken) {
      return request<T>(path, { ...options, _retry: true })
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
    try {
      const body = await res.json()
      errorMessage = body?.error?.message ?? errorMessage
      // Технічні префікси кодів із БД-помилок (INSUFFICIENT_STOCK: ...) користувачу не потрібні
      errorMessage = errorMessage.replace(/^[A-Z][A-Z_]{2,}:\s*/, '')
    } catch { /* response не JSON */ }

    if (!silent) {
      import('@/components/ui/Toast').then(({ toast }) => toast.error(errorMessage))
    }
    const err = new Error(errorMessage)
    ;(err as any).status = res.status
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
