import { DesktopSessionLifecycleError, type ServerSessionSaveResult } from './desktopSessionLifecycle'

export interface ServerTokens { access_token: string; refresh_token: string }
export interface ServerIdentity { id: string; tenant_id: string; generation: number }

export function checkedServerTokens(value: unknown): ServerTokens {
  const input = value as Partial<ServerTokens> | null
  if (!input || typeof input.access_token !== 'string' || typeof input.refresh_token !== 'string'
    || input.access_token.length > 32768 || input.refresh_token.length > 4096
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.access_token)
    || !input.refresh_token || /\s/.test(input.refresh_token)) throw Error('Некоректна серверна сесія')
  return { access_token: input.access_token, refresh_token: input.refresh_token }
}

/** A cache only, never authority for local login. The fixed Auth server verifies the token. */
export async function verifyAndRememberServerSession(input: unknown, deps: {
  current: () => ServerIdentity
  config: { supabaseUrl: string; supabaseAnonKey: string }
  fetch: (url: string, options: RequestInit) => Promise<Response>
  save: (identity: ServerIdentity, tokens: ServerTokens) => void
}): Promise<ServerSessionSaveResult> {
  const tokens = checkedServerTokens(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const identity = deps.current()
    const response = await deps.fetch(deps.config.supabaseUrl + '/auth/v1/user', {
      headers: { apikey: deps.config.supabaseAnonKey, Authorization: 'Bearer ' + tokens.access_token },
      signal: controller.signal,
    })
    if (!response.ok) throw Error('Сервер не підтвердив сесію акаунта')
    const user = await response.json() as {id?:unknown;app_metadata?:Record<string,unknown>}
    const meta = user?.app_metadata
    if (user?.id !== identity.id || meta?.tenant_id !== identity.tenant_id
      || meta.is_active === false || meta.can_login === false || meta.deleted_at || meta.role === 'tire_worker')
      throw Error('Серверна сесія не відповідає поточному працівнику')
    const current = deps.current()
    if (current.id !== identity.id || current.tenant_id !== identity.tenant_id || current.generation !== identity.generation)
      throw new DesktopSessionLifecycleError('superseded', 'Спробу відновлення сесії скасовано')
    deps.save(identity, tokens)
    return { success: true }
  } catch (error) {
    if (error instanceof DesktopSessionLifecycleError) return { success: false, reason: error.reason }
    // Provider/network errors can contain credentials. Never propagate their body/URL.
    throw Error('Не вдалося захищено зберегти серверну сесію. Локальний вхід не змінено.')
  } finally { clearTimeout(timeout) }
}
