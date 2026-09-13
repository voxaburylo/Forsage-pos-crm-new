import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { safeDiagnosticDetails, safeDiagnosticEvent } from './blackBoxData'

export class BlackBox {
  private worker: Worker | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private pending = 0
  private dropped = 0
  private closing: Promise<void> | null = null
  private finishClose: (() => void) | null = null
  constructor(dir: string) {
    try {
      this.worker = new Worker(path.join(__dirname, 'blackBoxWorker.js'), { workerData: { dir, run: randomUUID() } })
      this.worker.unref()
      this.worker.on('message', message => {
        if (message.type === 'ack') this.pending = Math.max(0, this.pending - 1)
        if (message.type === 'closed') this.finishClose?.()
      })
      this.worker.on('error', () => this.stop())
      this.worker.on('exit', () => this.stop())
      let previous = Date.now(), ticks = 0
      this.heartbeat = setInterval(() => {
        const now = Date.now(), lag = Math.max(0, now - previous - 5_000)
        previous = now
        if (lag > 2_000) this.record('main-event-loop-delay', { lag_ms: lag })
        if (++ticks % 6 === 0) this.record('health', { rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024), dropped: this.dropped })
        try { this.worker?.postMessage({ type: 'heartbeat' }) } catch { this.stop() }
      }, 5_000)
      this.heartbeat.unref()
    } catch { this.stop() }
  }
  record(event: string, details: unknown = {}): void {
    if (!this.worker || this.closing) return
    if (this.pending >= 500) { this.dropped++; return }
    try {
      this.worker.postMessage({ type: 'record', at: new Date().toISOString(), event: safeDiagnosticEvent(event), details: safeDiagnosticDetails(details) })
      this.pending++
    } catch { this.stop() }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (!this.worker) return Promise.resolve()
    this.closing = new Promise(resolve => {
      const timeout = setTimeout(() => { void this.worker?.terminate(); this.stop(); resolve() }, 2_000)
      this.finishClose = () => { clearTimeout(timeout); this.stop(); resolve() }
      try { this.worker!.postMessage({ type: 'close' }) } catch { this.finishClose() }
    })
    return this.closing
  }
  private stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.worker = null
  }
}
