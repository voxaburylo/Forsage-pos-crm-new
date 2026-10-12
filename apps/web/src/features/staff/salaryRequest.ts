import { clearPendingLocalRequest, durableLocalRequest, localRequestFingerprint, pendingLocalRequests } from '@/lib/durableLocalRequest'

export type SalaryRequestKind = 'salary' | 'daily-salary'
type Result = Record<string, unknown>
type Resolution = { status: 'committed'; result: Result } | { status: 'not_committed' }
const active = new Map<string, { fingerprint: string; promise: Promise<Result> }>()
const unconfirmed = () => new Error('Не вдалося підтвердити операцію із зарплатою. Номер спроби збережено — перевірте її перед новою виплатою.')

function record(value: unknown): value is Result {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function validResult(kind: SalaryRequestKind, value: unknown): Result {
  if (!record(value)) throw unconfirmed()
  const payment = kind === 'salary' ? value : value.payment
  if (!record(payment) || typeof payment.id !== 'string' || !payment.id.trim()
    || !Number.isSafeInteger(payment.amount) || (payment.amount as number) <= 0) throw unconfirmed()
  if (kind === 'daily-salary' && value.amount !== payment.amount) throw unconfirmed()
  return value
}
function validResolution(kind: SalaryRequestKind, value: unknown): Resolution {
  if (!record(value)) throw unconfirmed()
  if (value.status === 'committed') return { status: 'committed', result: validResult(kind, value.result) }
  if (value.status === 'not_committed') return { status: 'not_committed' }
  throw unconfirmed()
}

/** Preserve old request IDs; only the local ledger may confirm or fence an uncertain write. */
export function submitSalaryRequest<Payload>(kind: SalaryRequestKind, scope: string, payload: Payload, transport: {
  send: (id: string, payload: Payload) => Promise<unknown>
  resolve?: (id: string) => Promise<unknown>
  sameSession: () => boolean
}, storage: Storage = localStorage): Promise<Result> {
  const request = structuredClone(payload)
  const fingerprint = localRequestFingerprint(request)
  const current = active.get(scope)
  if (current) return current.fingerprint === fingerprint ? current.promise
    : Promise.reject(new Error('Дочекайтеся завершення поточної операції із зарплатою.'))
  const assertSession = () => {
    if (!transport.sameSession()) throw new Error('Користувач змінився. Перевірте операцію із зарплатою під попереднім обліковим записом.')
  }
  const promise = Promise.resolve().then(async () => {
    assertSession()
    const resolve = transport.resolve
    if (!resolve) throw new Error('Оновіть локальну програму для безпечного збереження зарплати.')
    for (const previous of pendingLocalRequests(scope, storage)) {
      assertSession()
      const resolution = validResolution(kind, await resolve(previous.operationId))
      assertSession()
      clearPendingLocalRequest(scope, previous.operationId, storage)
      // Report a known commit before another uncertain lookup can hide that evidence.
      if (resolution.status === 'committed') {
        if (localRequestFingerprint(previous.payload) === fingerprint) return resolution.result
        throw new Error('Попередню операцію із зарплатою вже збережено. Перевірте історію перед новою виплатою.')
      }
    }
    assertSession()
    return durableLocalRequest(scope, request, async id => {
      assertSession()
      try {
        const result = validResult(kind, await transport.send(id, request))
        assertSession()
        return result
      } catch (writeError) {
        assertSession()
        let resolution: Resolution
        try { resolution = validResolution(kind, await resolve(id)) }
        catch { assertSession(); throw writeError }
        assertSession()
        if (resolution.status === 'committed') return resolution.result
        clearPendingLocalRequest(scope, id, storage)
        throw writeError
      }
    }, storage, { exclusive: true })
  }).finally(() => { active.delete(scope) })
  active.set(scope, { fingerprint, promise })
  return promise
}
