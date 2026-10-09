import { clearPendingLocalRequest, durableLocalRequest, localRequestFingerprint, pendingLocalRequests } from '@/lib/durableLocalRequest'

type Result = { success: true; importId: string }
type Resolution = { status: 'committed'; result: Result } | { status: 'not_committed' }
const active = new Map<string, { fingerprint: string; promise: Promise<Result> }>()
const unconfirmed = () => new Error('Не вдалося підтвердити імпорт прайсу. Повторіть ту саму спробу; її номер збережено.')
async function requestIdentity(fingerprint: string) {
  if (!globalThis.crypto?.subtle) throw new Error('Не вдалося підготувати захист повторного імпорту. Оновіть локальну програму.')
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint))
  return { version: 1, sha256: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('') }
}
function validResult(value: unknown): Result {
  const result = value as Partial<Result> | null
  if (result?.success !== true || typeof result.importId !== 'string' || !result.importId.trim()) throw unconfirmed()
  return { success: true, importId: result.importId }
}
function validResolution(value: unknown): Resolution {
  const result = value as { status?: string; result?: unknown } | null
  if (result?.status === 'committed') return { status: 'committed', result: validResult(result.result) }
  if (result?.status === 'not_committed') return { status: 'not_committed' }
  throw unconfirmed()
}

/** Keep the existing form; safely reconcile its previous attempt before another payload. */
export function submitCatalogImport(scope: string, payload: unknown, transport: {
  send: (id: string) => Promise<unknown>
  resolve: (id: string) => Promise<unknown>
  sameSession: () => boolean
}, storage: Storage = localStorage): Promise<Result> {
  const fingerprint = localRequestFingerprint(payload)
  const current = active.get(scope)
  if (current) return current.fingerprint === fingerprint ? current.promise
    : Promise.reject(new Error('Дочекайтеся завершення поточного імпорту прайсу.'))
  const assertSession = () => {
    if (!transport.sameSession()) throw new Error('Користувач змінився. Перевірте спробу імпорту під попереднім обліковим записом.')
  }
  const promise = Promise.resolve().then(async () => {
    assertSession()
    // Store only a small hash and ID, not an entire supplier price list in localStorage.
    const identity = await requestIdentity(fingerprint)
    assertSession()
    for (const previous of pendingLocalRequests(scope, storage)) {
      if (localRequestFingerprint(previous.payload) === localRequestFingerprint(identity)) continue
      const resolution = validResolution(await transport.resolve(previous.operationId))
      assertSession()
      clearPendingLocalRequest(scope, previous.operationId, storage)
      if (resolution.status === 'committed') throw new Error('Попередній прайс уже збережено. Перевірте історію імпортів перед новим завантаженням.')
    }
    return durableLocalRequest(scope, identity, async id => {
      assertSession()
      try {
        const result = validResult(await transport.send(id))
        assertSession()
        return result
      } catch (writeError) {
        assertSession()
        let resolution: Resolution
        try {
          resolution = validResolution(await transport.resolve(id))
          assertSession()
        } catch { throw writeError }
        if (resolution.status === 'committed') return resolution.result
        clearPendingLocalRequest(scope, id, storage)
        throw writeError
      }
    }, storage, { exclusive: true })
  }).finally(() => { active.delete(scope) })
  active.set(scope, { fingerprint, promise })
  return promise
}
