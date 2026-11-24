/**
 * 24.11.2026 (власник: «у веб-версії, якщо згорнути браузер або вийти з вкладки помічника, він перестає працювати»).
 * Запит помічника отримує номер; поки відповіді немає, номер лежить у браузері поруч з історією чату. Якщо
 * зʼєднання обірвалось (телефон згорнув браузер) або екран закрили (інша вкладка програми), екран, повернувшись,
 * забирає готову відповідь із сервера за цим номером — повторно платити за неї не треба.
 */
export type PendingAiReply = { id: string; message: string; started_at: number }
export type StoredAiReply = {
  data?: { reply: string; actions: unknown[]; usage?: { cost_usd?: number } }
  error?: { code?: string; message?: string; status?: number }
}

/** Скільки чекати готову відповідь: сервер працює до 5 хв, плюс запас. */
export const AI_PENDING_MAX_MS = 7 * 60 * 1000
export const AI_PENDING_POLL_MS = 3000

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function pendingKey(storageKey: string) { return storageKey + ':pending' }

export function readPendingReply(storageKey: string, storage: KeyValue): PendingAiReply | null {
  try {
    const raw = storage.getItem(pendingKey(storageKey))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingAiReply>
    if (typeof value?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id) || typeof value.started_at !== 'number') return null
    return { id: value.id, message: typeof value.message === 'string' ? value.message : '', started_at: value.started_at }
  } catch { return null }
}

export function writePendingReply(storageKey: string, storage: KeyValue, pending: PendingAiReply) {
  try { storage.setItem(pendingKey(storageKey), JSON.stringify(pending)) } catch { /* без цього просто не відновимо */ }
}

export function clearPendingReply(storageKey: string, storage: KeyValue, id?: string) {
  try {
    if (id && readPendingReply(storageKey, storage)?.id !== id) return
    storage.removeItem(pendingKey(storageKey))
  } catch { /* ignore */ }
}

/**
 * Зʼєднання обірвалось, а не сервер відмовив: у помилки немає коду відповіді сервера.
 * Відмову сервера (ліміт, ключ, перевірка) показуємо одразу, як і раніше.
 */
export function isLostConnection(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const status = (current as { status?: unknown }).status
    if (typeof status === 'number' && status > 0) return false
    const cause = (current as { cause?: unknown }).cause
    if (!cause) break
    current = cause
  }
  return !!error
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function newAiRequestId(random: () => string = randomUuid): string {
  return random().toLowerCase()
}

export type PendingOutcome =
  | { kind: 'reply'; data: NonNullable<StoredAiReply['data']> }
  | { kind: 'error'; message: string }
  | { kind: 'expired' }
  | { kind: 'stopped' }

/** Чекає готову відповідь сервера, поки екран відкритий. */
export async function waitForPendingReply(pending: PendingAiReply, deps: {
  fetchResult: (id: string) => Promise<StoredAiReply | null>
  shouldStop: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<PendingOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (;;) {
    if (deps.shouldStop()) return { kind: 'stopped' }
    let stored: StoredAiReply | null = null
    try { stored = await deps.fetchResult(pending.id) } catch { stored = null }
    if (deps.shouldStop()) return { kind: 'stopped' }
    if (stored?.data && typeof stored.data.reply === 'string') return { kind: 'reply', data: { ...stored.data, actions: Array.isArray(stored.data.actions) ? stored.data.actions : [] } }
    if (stored?.error) return { kind: 'error', message: stored.error.message || 'Помилка ШІ' }
    if (now() - pending.started_at > AI_PENDING_MAX_MS) return { kind: 'expired' }
    await sleep(AI_PENDING_POLL_MS)
  }
}
