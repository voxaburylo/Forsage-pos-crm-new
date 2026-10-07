/** Expected end of a local login, not a provider/storage failure. Never contains credentials. */
export class DesktopSessionLifecycleError extends Error {
  readonly name = 'DesktopSessionLifecycleError'
  constructor(
    readonly reason: 'local-session-ended' | 'superseded',
    message: string,
  ) { super(message) }
}

export type ServerSessionSaveResult =
  | { success: true }
  | { success: false; reason: DesktopSessionLifecycleError['reason'] }

/**
 * Only the two optional cache commands may finish without an authenticated session.
 * They return no credentials and perform no write in that case; ordinary commands still fail closed.
 */
export function serverSessionCacheResultForError(
  channel: string, error: unknown,
): ServerSessionSaveResult | null | undefined {
  if (!(error instanceof DesktopSessionLifecycleError)) return undefined
  if (channel === 'desktop:auth:save-server-session') return { success: false, reason: error.reason }
  if (channel === 'desktop:auth:restore-server-session' && error.reason === 'local-session-ended') return null
  return undefined
}
