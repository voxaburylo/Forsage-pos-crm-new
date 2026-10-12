/** Ask outside beforeunload: Electron does not support a renderer confirm there. */
export function requestUnloadScript(deadline: number): string {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) throw new Error('Invalid close approval deadline')
  return `(() => {
  const detail = { handled: false, approved: false, deadline: ${JSON.stringify(deadline)} };
  window.dispatchEvent(new CustomEvent('forsage:request-unload', { detail }));
  return detail.handled === false || (detail.handled === true && detail.approved === true);
})()`
}

type CloseEvent = { preventDefault: () => void }
type PendingApproval = { deadline: number; expired: boolean; timer: ReturnType<typeof setTimeout> | null }

/** Return before shutdown work while the main renderer can still veto departure. */
export function deferQuitForMainWindow(event: CloseEvent, window: { isDestroyed: () => boolean; close: () => void } | null): boolean {
  if (!window || window.isDestroyed()) return false
  event.preventDefault()
  window.close()
  return true
}

/** Owns only the main-window close handshake, never resource shutdown or destroy(). */
export class NativeCloseController {
  private pending: PendingApproval | null = null
  private approvedRetry = false
  private stopped = false

  constructor(private readonly options: {
    isDestroyed: () => boolean
    requestApproval: (deadline: number) => Promise<unknown>
    close: () => void
    failed?: (error: unknown) => void
    timeoutMs?: number
  }) {}

  onClose(event: CloseEvent): void {
    if (this.approvedRetry) { this.approvedRetry = false; return }
    event.preventDefault()
    if (this.stopped || this.pending || this.options.isDestroyed()) return
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const attempt: PendingApproval = { deadline: Date.now() + timeoutMs, expired: false, timer: null }
    this.pending = attempt
    attempt.timer = setTimeout(() => {
      attempt.expired = true
      // Keep the slot until the original request settles: a slow native prompt
      // must not acquire a second competing prompt after this deadline.
      this.options.failed?.(new Error('RENDERER_CLOSE_APPROVAL_TIMEOUT'))
    }, timeoutMs)
    void Promise.resolve().then(() => {
      if (this.stopped || this.pending !== attempt || this.options.isDestroyed() || Date.now() >= attempt.deadline) return false
      return this.options.requestApproval(attempt.deadline)
    }).then(approved => {
      if (approved !== true || attempt.expired || Date.now() >= attempt.deadline || this.stopped || this.pending !== attempt || this.options.isDestroyed()) return
      this.closeWithNativeRetry()
    }).catch(error => {
      if (!this.stopped && this.pending === attempt) this.options.failed?.(error)
    }).finally(() => {
      if (attempt.timer !== null) clearTimeout(attempt.timer)
      if (this.pending === attempt) this.pending = null
    })
  }

  /** Only the existing native recovery dialog's explicit "Close program" choice. */
  closeAfterConfirmedRecovery(): void {
    if (this.stopped || this.options.isDestroyed()) return
    this.clearPending()
    try { this.closeWithNativeRetry() } catch (error) { this.options.failed?.(error) }
  }

  stop(): void {
    this.stopped = true
    this.approvedRetry = false
    this.clearPending()
  }

  private closeWithNativeRetry(): void {
    this.approvedRetry = true
    try {
      // BrowserWindow.close emits close, then still runs renderer beforeunload.
      // Do not destroy the window or suppress will-prevent-unload here.
      this.options.close()
    } finally {
      this.approvedRetry = false
    }
  }

  private clearPending(): void {
    if (this.pending?.timer !== null && this.pending?.timer !== undefined) clearTimeout(this.pending.timer)
    this.pending = null
  }
}
