import type { CreateOrderPayload, CustomerOrder } from './orderApi'

export interface OrderSaveAttempt { version: 1; operationId: string; orderId?: string; payload: CreateOrderPayload; activate: boolean }
const key = (scope: string) => `forsage:order-save-attempt:v1:${scope}`
export function readOrderSaveAttempt(scope: string, storage: Storage = localStorage): OrderSaveAttempt | null {
  const raw = storage.getItem(key(scope))
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !/^[a-zA-Z0-9-]{16,80}$/.test(value.operationId ?? '') || !Array.isArray(value.payload?.items)
      || (value.orderId !== undefined && typeof value.orderId !== 'string') || typeof value.activate !== 'boolean') throw Error()
    return value
  } catch { throw new Error('Пошкоджено журнал збереження замовлення. Не створюйте його повторно — потрібна перевірка журналу.') }
}
export function beginOrderSaveAttempt(scope: string, payload: CreateOrderPayload, orderId: string | undefined, activate: boolean, storage: Storage = localStorage): OrderSaveAttempt {
  if (readOrderSaveAttempt(scope, storage)) throw new Error('Спочатку перевірте результат попереднього збереження замовлення')
  const pending: OrderSaveAttempt = { version: 1, operationId: crypto.randomUUID(), orderId, payload: structuredClone(payload), activate }
  storage.setItem(key(scope), JSON.stringify(pending))
  return pending
}
export function clearOrderSaveAttempt(scope: string, storage: Storage = localStorage): void { storage.removeItem(key(scope)) }
export async function checkOrderSaveAttempt(scope: string, lookup: (operationId: string, orderId?: string) => Promise<CustomerOrder | null>, storage: Storage = localStorage): Promise<CustomerOrder | null> {
  const pending = readOrderSaveAttempt(scope, storage)
  if (!pending) return null
  const result = await lookup(pending.operationId, pending.orderId)
  // A successful result is cleared only together with the form by the caller.
  if (!result) clearOrderSaveAttempt(scope, storage)
  return result
}
