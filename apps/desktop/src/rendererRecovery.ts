/** A single load loop owns initial loading and crash recovery for one window. */
export class RendererRecovery {
  private flight: Promise<void> | null = null
  private stopped = false
  private generation = 0
  private crashTimes: number[] = []
  private cancelDelay: (() => void) | null = null

  constructor(private readonly options: {
    load: () => Promise<unknown>
    isDestroyed: () => boolean
    retry: (attempt: number, error: unknown) => void
    delays?: number[]
  }) {}

  start(): Promise<void> {
    if (this.stopped || this.options.isDestroyed()) return Promise.resolve()
    if (this.flight) return this.flight
    // Assign flight before calling native load: an event can reenter during that call.
    const flight = Promise.resolve().then(() => this.run()).finally(() => { if (this.flight === flight) this.flight = null })
    this.flight = flight
    return flight
  }

  crashed(): Promise<void> {
    if (this.stopped || this.options.isDestroyed()) return Promise.resolve()
    const now = Date.now()
    this.crashTimes = this.crashTimes.filter((time) => now - time < 60_000)
    this.crashTimes.push(now)
    this.generation++
    if (this.crashTimes.length > 2) {
      this.stop()
      return Promise.reject(new Error('Інтерфейс аварійно завершився кілька разів. Причину записано у журнал. Перезапустіть програму.'))
    }
    return this.start()
  }

  stop(): void {
    this.stopped = true
    this.cancelDelay?.()
  }

  private async run(): Promise<void> {
    const delays = this.options.delays ?? [250, 500, 1000, 2000, 3000]
    let lastError: unknown
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (this.stopped || this.options.isDestroyed()) return
      const generation = this.generation
      try {
        await this.options.load()
        if (this.stopped || this.options.isDestroyed()) return
        if (generation === this.generation) return
        lastError = new Error('Інтерфейс завершився під час завантаження')
      } catch (error) { lastError = error }
      if (this.stopped || this.options.isDestroyed()) return
      this.options.retry(attempt + 1, lastError)
      if (attempt < delays.length) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.cancelDelay = null; resolve() }
        const timer = setTimeout(done, delays[attempt])
        this.cancelDelay = done
      })
    }
    throw lastError instanceof Error ? lastError : new Error('Не вдалося завантажити інтерфейс Forsage')
  }
}
