import type { LocalSyncOutboxOperation, LocalSyncPullState, LocalSyncPushResult } from '../db/localTypes'

/**
 * 23.11.2026: зміни каси йдуть на сервер ключем самого головного ПК з головного процесу.
 * Раніше їх надсилало лише вікно програми сесією того, хто увійшов: правка власника з вебу (chat ID бота, PIN,
 * налаштування) застрягала з «Недостатньо прав», бо в касу увійшов касир; а у фоні (без вікна) не йшло нічого.
 * Правила ті самі, що були у вікні (desktopSyncBatch.ts): не обганяти чергу, не перевищувати розмір запиту,
 * приймати лише підтвердження саме цих документів.
 */
export const OUTBOX_PUSH_BATCH = 10
/** Нижче межі розбору запиту на сервері (4 МіБ); рахуємо байти UTF-8, а не символи. */
export const OUTBOX_PUSH_MAX_BYTES = 3.5 * 1024 * 1024

export interface OutboxPushResult { pushed: number; failed: number; pending: number; resetRequired: boolean }
export interface OutboxStore {
  listPending(limit?: number): LocalSyncOutboxOperation[]
  getPullState(): LocalSyncPullState
  applyPushResults(results: LocalSyncPushResult[]): void
  markBatchFailed(sequences: number[], error: string): void
}
export type OutboxSend = (body: { reset_generation: number; operations: LocalSyncOutboxOperation[] }) => Promise<unknown>

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

export function selectPushBatch(operations: LocalSyncOutboxOperation[], resetGeneration: number, maxBytes = OUTBOX_PUSH_MAX_BYTES) {
  let size = bytes({ reset_generation: resetGeneration, operations: [] })
  const selected: LocalSyncOutboxOperation[] = []
  for (const operation of operations) {
    const next = bytes(operation) + (selected.length ? 1 : 0)
    // Не перескакуємо: пізніші документи можуть залежати від цього.
    if (size + next > maxBytes) return { operations: selected, oversized: selected.length ? null : operation }
    selected.push(operation)
    size += next
  }
  return { operations: selected, oversized: null as LocalSyncOutboxOperation | null }
}

export function validatePushResults(operations: LocalSyncOutboxOperation[], response: unknown): LocalSyncPushResult[] {
  if (!Array.isArray(response)) throw new Error('Сервер не підтвердив отримання документів')
  const expected = new Map(operations.map(operation => [operation.sequence, operation.operation_id]))
  const received = new Map<number, LocalSyncPushResult>()
  for (const result of response as LocalSyncPushResult[]) {
    if (!result || !expected.has(result.sequence) || expected.get(result.sequence) !== result.operation_id
      || received.has(result.sequence) || !['synced', 'failed', 'discarded'].includes(result.status)) {
      throw new Error('Некоректне підтвердження синхронізації. Документи залишено для повторної передачі')
    }
    received.set(result.sequence, result)
  }
  return operations.map(operation => received.get(operation.sequence) ?? {
    sequence: operation.sequence, operation_id: operation.operation_id, status: 'failed' as const,
    error: 'Сервер не підтвердив цей документ. Передачу буде повторено',
  })
}

/** Одна передача пачки. Помилка зв'язку позначає пачку для повтору й летить далі — викликач вирішує, коли повторити. */
export async function pushOutboxOnce(store: OutboxStore, send: OutboxSend, limit = OUTBOX_PUSH_BATCH): Promise<OutboxPushResult> {
  const pending = store.listPending(limit)
  if (!pending.length) return { pushed: 0, failed: 0, pending: 0, resetRequired: false }
  const resetGeneration = store.getPullState().reset_generation
  const { operations, oversized } = selectPushBatch(pending, resetGeneration)
  if (oversized) {
    store.markBatchFailed([oversized.sequence], 'Документ завеликий для передачі на сервер. Локальні дані збережено; потрібна перевірка синхронізації')
    return { pushed: 0, failed: 1, pending: pending.length - 1, resetRequired: false }
  }
  let answer: { results?: unknown; reset_required?: boolean } | null
  try {
    answer = await send({ reset_generation: resetGeneration, operations }) as typeof answer
  } catch (error) {
    store.markBatchFailed(operations.map(operation => operation.sequence), error instanceof Error ? error.message : 'Помилка передачі на сервер')
    throw error
  }
  const results = validatePushResults(operations, answer?.results)
  store.applyPushResults(results)
  return {
    pushed: results.filter(result => result.status === 'synced').length,
    failed: results.filter(result => result.status === 'failed').length,
    pending: pending.length - operations.length,
    resetRequired: answer?.reset_required === true || results.some(result => result.status === 'discarded'),
  }
}

export const OUTBOX_IDLE_MS = 60_000
export const OUTBOX_BUSY_MS = 5_000
export const OUTBOX_RETRY_MS = [15_000, 30_000, 60_000, 120_000]

/**
 * Передача у фоні головного процесу: одна за раз, з повтором після збою. `available` — чи є ключ ПК і чи це головний ПК;
 * коли ні — нічого не робить і повертає null (тоді вікно програми надсилає по-старому, сесією працівника).
 */
export class OutboxPusher {
  private running: Promise<OutboxPushResult | null> | null = null
  private timer: unknown = null
  private attempt = 0
  private stopped = true

  constructor(private readonly deps: {
    available: () => boolean
    store: () => OutboxStore | null
    send: OutboxSend
    onError?: (error: unknown) => void
    setTimer?: (run: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
  }) {}

  start(): void { if (this.stopped) { this.stopped = false; this.schedule(OUTBOX_BUSY_MS) } }
  stop(): void { this.stopped = true; this.clear() }

  /** Передати зараз (після дії вебу чи з вікна програми). Паралельні виклики чекають ту саму передачу. */
  pushNow(): Promise<OutboxPushResult | null> {
    if (this.running) return this.running
    const run = this.execute()
    this.running = run
    const release = () => { if (this.running === run) this.running = null }
    run.then(release, release)
    return run
  }

  /** Найближчим часом, без очікування результату (дія вебу щойно змінила базу). */
  soon(ms = 1_500): void { if (!this.stopped) this.schedule(ms) }

  private async execute(): Promise<OutboxPushResult | null> {
    const store = this.deps.available() ? this.deps.store() : null
    if (!store) return null
    try {
      const result = await pushOutboxOnce(store, this.deps.send)
      this.attempt = result.failed > 0 ? this.attempt + 1 : 0
      if (!this.stopped) this.schedule(result.failed > 0 ? this.retryDelay() : result.pushed > 0 || result.pending > 0 ? OUTBOX_BUSY_MS : OUTBOX_IDLE_MS)
      return result
    } catch (error) {
      this.attempt += 1
      this.deps.onError?.(error)
      if (!this.stopped) this.schedule(this.retryDelay())
      throw error
    }
  }

  private retryDelay() { return OUTBOX_RETRY_MS[Math.min(Math.max(this.attempt, 1), OUTBOX_RETRY_MS.length) - 1] }
  private clear() { if (this.timer !== null) { (this.deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer); this.timer = null } }
  private schedule(ms: number) {
    this.clear()
    this.timer = (this.deps.setTimer ?? ((run, delay) => setTimeout(run, delay)))(() => { this.timer = null; void this.pushNow().catch(() => undefined) }, ms)
  }
}
