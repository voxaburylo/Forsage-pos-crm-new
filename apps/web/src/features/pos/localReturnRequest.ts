import type { CreateReturnBody, CustomerReturn } from '@/types/return'

type Attempt = { version: 1; id: string; fingerprint: string; shift_id: string | null }
type Transport = {
  getOpenShift: (id: string) => Promise<{ id: string } | null>
  createReturn: (input: unknown) => Promise<CustomerReturn>
  getReturnByOperation: (id: string) => Promise<CustomerReturn | null>
}
const active = new Map<string, { fingerprint: string; task: Promise<CustomerReturn> }>()
const key = (scope: string) => `forsage:return-attempt:v1:${scope}`
export function readLocalReturnAttempt(scope: string, storage: Storage = localStorage): Attempt | null {
  const source = storage.getItem(key(scope))
  if (!source) return null
  try {
    const value = JSON.parse(source)
    if (value?.version !== 1 || typeof value.id !== 'string' || !value.id
      || typeof value.fingerprint !== 'string' || (value.shift_id !== null && typeof value.shift_id !== 'string')) throw Error()
    return value
  } catch { throw new Error('Пошкоджено журнал повернення. Не оформлюйте його повторно — потрібна перевірка журналу.') }
}
export async function checkLocalReturnAttempt(scope: string, lookup: Transport['getReturnByOperation'], storage: Storage = localStorage): Promise<CustomerReturn | null> {
  if (active.has(scope)) throw new Error('Дочекайтеся завершення поточного повернення')
  const pending = readLocalReturnAttempt(scope, storage)
  if (!pending) return null
  const result = await lookup(pending.id)
  // Only a successful authoritative lookup can clear an uncertain operation.
  storage.removeItem(key(scope))
  return result
}
export function createLocalReturn(scope: string, cashierId: string, body: CreateReturnBody, transport: Transport,
  storage: Storage = localStorage, proposedId?: string): Promise<CustomerReturn> {
  // Snapshot before awaiting IPC: the caller must not change the payload behind its persisted identity.
  const request = structuredClone(body)
  if (!request.items?.length || request.items.some(item => typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
    return Promise.reject(new Error('Некоректна кількість повернення'))
  }
  const fingerprint = JSON.stringify(request)
  const running = active.get(scope)
  if (running) return running.fingerprint === fingerprint ? running.task : Promise.reject(new Error('Дочекайтеся завершення поточного повернення'))
  const task = Promise.resolve().then(async () => {
    let pending = readLocalReturnAttempt(scope, storage)
    if (pending && pending.fingerprint !== fingerprint) throw new Error('Спочатку перевірте результат попереднього повернення')
    if (!pending) {
      const shift = await transport.getOpenShift(cashierId)
      pending = { version: 1, id: proposedId || crypto.randomUUID(), fingerprint, shift_id: shift?.id ?? null }
      storage.setItem(key(scope), JSON.stringify(pending))
    }
    let result: CustomerReturn
    try {
      result = await transport.createReturn({ ...request, client_operation_id: pending.id, approved_by: cashierId, shift_id: pending.shift_id })
    } catch (error) {
      let saved: CustomerReturn | null
      try { saved = await transport.getReturnByOperation(pending.id) }
      catch { throw new Error('Результат повернення не підтверджено. Не видавайте гроші повторно — натисніть «Перевірити повернення».') }
      if (!saved) {
        storage.removeItem(key(scope))
        throw error
      }
      result = saved
    }
    storage.removeItem(key(scope))
    return result
  }).finally(() => { active.delete(scope) })
  active.set(scope, { fingerprint, task })
  return task
}
