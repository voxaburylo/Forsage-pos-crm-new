export function reportLocalError(error: unknown, kind: 'renderer-error' | 'renderer-rejection' = 'renderer-error'): void {
  try {
    window.forsageDesktop?.diagnostics?.reportError(kind,
      error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack ?? '' : '')
  } catch { /* recording an error must never produce another failure */ }
}

export function installLocalDiagnostics(): void {
  if (!window.forsageDesktop?.diagnostics) return
  window.addEventListener('error', event => reportLocalError(event.error ?? event.message))
  window.addEventListener('unhandledrejection', event => reportLocalError(event.reason, 'renderer-rejection'))
}
