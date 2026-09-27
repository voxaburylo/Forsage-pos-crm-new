import { AppError } from '../middleware/errorHandler.js'

export const AI_TIME_LIMITS = { chat: 240_000, invoice: 150_000, keyTest: 15_000, read: 30_000 } as const

export function isAiBudgetError(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'AI_TIMEOUT' || error.code === 'AI_READ_LIMIT')
}

const timeoutError = () => new AppError('AI_TIMEOUT', 'ШІ не завершив операцію вчасно. Зміни не застосовано; повторіть запит.', 504)

/** One wall-clock deadline, shared across attempts, tools and fallback recognition. */
export class AiExecutionBudget {
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly parent?: AbortSignal
  private disposed = false
  private readonly abort = () => this.controller.abort()

  constructor(ms: number, parent?: AbortSignal) {
    this.expiresAt = Date.now() + ms
    this.parent = parent
    this.timer = setTimeout(this.abort, ms)
    this.timer.unref?.()
    parent?.addEventListener('abort', this.abort, { once: true })
    if (parent?.aborted) this.abort()
  }

  get signal(): AbortSignal { return this.controller.signal }

  check(): void {
    if (Date.now() >= this.expiresAt) this.abort()
    if (this.disposed || this.signal.aborted) throw timeoutError()
  }

  async run<T>(operation: (signal: AbortSignal) => PromiseLike<T> | T): Promise<T> {
    this.check()
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (ok: boolean, value: unknown) => {
        if (settled) return
        settled = true
        this.signal.removeEventListener('abort', onAbort)
        if (ok) resolve(value as T)
        else reject(value)
      }
      const onAbort = () => finish(false, timeoutError())
      this.signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.check()
        Promise.resolve(operation(this.signal)).then(value => {
          try { this.check(); finish(true, value) } catch (error) { finish(false, error) }
        }, error => finish(false, this.signal.aborted ? timeoutError() : error))
      } catch (error) { finish(false, error) }
    })
  }

  async delay(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await this.run(() => new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })) }
    finally { if (timer) clearTimeout(timer) }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.abort)
    this.abort()
  }
}

export async function withAiExecutionBudget<T>(
  ms: number, work: (budget: AiExecutionBudget) => Promise<T>, parent?: AbortSignal,
): Promise<T> {
  const budget = new AiExecutionBudget(ms, parent)
  try { return await budget.run(() => work(budget)) }
  finally { budget.dispose() }
}
