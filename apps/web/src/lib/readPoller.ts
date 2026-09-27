/** Completion-based polling for reads only. Never retry a write with this helper. */
export function createReadPoller<T>(options: {
  read: () => Promise<T>
  onData?: (value: T) => void
  onError?: (error: unknown) => void
  intervalMs: number
  canRead?: () => boolean
}) {
  let stopped = false, running = false, requested = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const allowed = () => !stopped && (options.canRead?.() ?? true)
  function schedule(delay: number) {
    if (stopped) return
    timer = setTimeout(wake, Math.max(100, delay))
  }
  async function run() {
    running = true
    try {
      const value = await options.read()
      if (allowed()) options.onData?.(value)
    } catch (error) {
      if (allowed()) options.onError?.(error)
    } finally {
      running = false
      const delay = requested ? 100 : options.intervalMs
      requested = false
      schedule(delay)
    }
  }
  function wake() {
    if (stopped) return
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    if (running) { requested = true; return }
    if (!allowed()) { schedule(options.intervalMs); return }
    // A presentation callback must not create an unhandled rejection in a timer.
    void run().catch(() => {})
  }
  return {
    wake,
    stop() { stopped = true; requested = false; if (timer !== undefined) clearTimeout(timer); timer = undefined },
  }
}
