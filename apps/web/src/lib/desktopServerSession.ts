import { createClient, type Session } from '@supabase/supabase-js'
import { desktopBridge, isDesktopRuntime, type DesktopServerSessionSaveResult } from './desktopBridge'
import { supabase } from './supabase'
import { withRequestDeadline } from './requestDeadline'
import { reportLocalError } from './localDiagnostics'

const restoring = new WeakMap<Session, Promise<Session | null>>()
type SaveResult = DesktopServerSessionSaveResult | null
const saving = new Map<string, { current: () => boolean; promise: Promise<SaveResult> }>()

export async function rememberDesktopServerSession(
  session: Session, current: () => boolean = () => true,
): Promise<SaveResult> {
  const auth = desktopBridge()?.auth
  const save = auth?.saveServerSession
  if (!isDesktopRuntime() || !save || !session.access_token || session.access_token.startsWith('local-desktop-')) return null
  const superseded = (): SaveResult => ({ success: false, reason: 'superseded' })
  if (!current()) return superseded()
  const key = session.access_token
  const prior = saving.get(key)
  if (prior?.current()) return prior.promise
  const flight = (async (): Promise<SaveResult> => {
    // Auth may refresh hourly after the local day has ended. Check main before
    // sending credentials; main still validates again to close the midnight race.
    if (auth?.rememberedStatus) {
      const status = await withRequestDeadline(() => auth.rememberedStatus!(), 5000)
      if (!current()) return superseded()
      if (status.locked || !status.available) return { success: false, reason: 'local-session-ended' }
    }
    if (!current()) return superseded()
    return await save({ access_token: session.access_token, refresh_token: session.refresh_token })
  })().catch(() => {
    reportLocalError(new Error('AI_SERVER_SESSION_CACHE_FAILED'))
    return null
  }).finally(() => { if (saving.get(key)?.promise === flight) saving.delete(key) })
  saving.set(key, { current, promise: flight })
  return flight
}
function matches(session: Session | null, local: Session): session is Session {
  const meta = session?.user.app_metadata
  return !!session && !!meta && session.user.id === local.user.id && meta.tenant_id === local.user.app_metadata?.tenant_id
    && meta.is_active !== false && meta.can_login !== false && !meta.deleted_at && meta.role !== 'tire_worker'
}

/** Restore only main's encrypted, still-valid day session. No passwords or localStorage tokens. */
export function restoreDesktopServerSession(local: Session, current: () => boolean): Promise<Session | null> {
  if (!local?.user?.id || !local.user.app_metadata?.tenant_id || !isDesktopRuntime()
    || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Promise.resolve(null)
  const restore = desktopBridge()?.auth?.restoreServerSession
  if (!restore) return Promise.resolve(null)
  const prior = restoring.get(local)
  if (prior) return prior
  const flight = (async () => {
    const tokens = await restore()
    if (!tokens || !current()) return null
    const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_ANON_KEY
    if (!url || !key) return null
    const result = await withRequestDeadline(async signal => {
      // Late refresh must not publish a global session for an employee who has logged out.
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
      })
      const response = await client.auth.setSession(tokens)
      signal.throwIfAborted()
      return response
    }, 15000)
    if (result.error || !matches(result.data.session, local) || !current()) return null
    // Save rotated credentials before attaching; a later network failure must not lose the refresh.
    const cached = await rememberDesktopServerSession(result.data.session, current)
    if (cached?.success === false || !current()) return null
    const attached = await withRequestDeadline(() => supabase.auth.setSession({
      access_token: result.data.session!.access_token, refresh_token: result.data.session!.refresh_token,
    }), 15000)
    return current() && !attached.error && matches(attached.data.session, local) ? attached.data.session : null
  })().catch(() => null).finally(() => { restoring.delete(local) })
  restoring.set(local, flight)
  return flight
}
