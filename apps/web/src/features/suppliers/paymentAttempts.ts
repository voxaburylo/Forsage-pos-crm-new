/** A failed response must not turn the next click into a second payment. */
export class PaymentAttempts<T> {
  private readonly attempts = new Map<string, { id: string; active?: Promise<T> }>()

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  run(key: string, send: (id: string) => Promise<T>): Promise<T> {
    let attempt = this.attempts.get(key)
    if (attempt?.active) return attempt.active
    if (!attempt) {
      attempt = { id: this.newId() }
      this.attempts.set(key, attempt)
    }
    const current = attempt
    const job = Promise.resolve().then(() => send(current.id))
    current.active = job
    void job.then(() => {
      if (this.attempts.get(key) === current) this.attempts.delete(key)
    }, () => { current.active = undefined })
    return job
  }
}
