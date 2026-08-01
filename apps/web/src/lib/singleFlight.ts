/** Shares one live asynchronous action with every repeated click. */
export class SingleFlight<T> {
  private active: Promise<T> | null = null

  run(action: () => Promise<T>): Promise<T> {
    if (this.active) return this.active

    const job = Promise.resolve().then(action)
    this.active = job
    const release = () => {
      if (this.active === job) this.active = null
    }
    job.then(release, release)
    return job
  }

  get isActive(): boolean {
    return this.active !== null
  }
}
