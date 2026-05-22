const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
  silent?: boolean   // true = не показувати автоматичний toast
  _retry?: boolean   // внутрішній прапор — запобігає infinite loop при refresh
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

export async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const token = await getAccessToken()
  const { silent, _retry, ...fetchOptions } = options ?? {}

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...fetchOptions.headers,
      },
    })
  } catch (networkErr) {
    // Network error (сервер недоступний або DNS не резолвиться)
    const msg = 'Сервер недоступний. Перевірте підключення до мережі.'
    if (!silent) {
      import('@/components/ui/Toast').then(({ toast }) => toast.error(msg))
    }
    throw new Error(msg)
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
  get:    <T>(path: string, opts?: Pick<RequestOptions, 'silent'>) => request<T>(path, opts),
  post:   <T>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: 'POST',  body: JSON.stringify(body), headers }),
  put:    <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT',   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string)               => request<T>(path, { method: 'DELETE' }),
}
