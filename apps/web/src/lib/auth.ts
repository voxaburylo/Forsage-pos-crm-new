import { supabase } from './supabase'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

// Вхід через backend /api/v1/auth/login (з rate limit + phone validation)
export async function signIn(phone: string, password: string) {
  const normalized = normalizePhone(phone)

  // Retry up to 2 extra times to handle Render cold start (free tier sleeps)
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: normalized, password }),
        signal: AbortSignal.timeout(20000),
      })

      const body = await res.json()

      if (!res.ok) {
        throw new Error(body?.error?.message ?? 'Невірний номер телефону або пароль')
      }

      const { error } = await supabase.auth.setSession({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
      })
      if (error) throw new Error('Помилка встановлення сесії')
      return body
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      // Only retry on network errors (not auth errors like wrong password)
      if (lastErr.message !== 'Невірний номер телефону або пароль' &&
          lastErr.message !== 'Помилка встановлення сесії' &&
          !lastErr.message.startsWith('HTTP ') &&
          attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      throw lastErr
    }
  }
  throw lastErr ?? new Error('Помилка входу')
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}
