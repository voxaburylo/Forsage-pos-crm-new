/**
 * 24.11.2026 (план C2, рішення власника: «одне завантаження фото — одна пачка»): що створила одна загрузка блокнота.
 * Замовлення, створені з одного повідомлення помічника (одні фото), запамʼятовуються, щоб усю пачку можна було
 * скасувати одним рухом. Памʼять — лише в цьому вікні браузера/програми; скасовує сама каса за своїми правилами.
 */
export interface BatchOrderRef { order_id: string; order_number: number | null; customer_id: string | null; customer_created: boolean }
type BatchStore = Record<string, BatchOrderRef>

const keyOf = (chatKey: string) => chatKey + ':order-batch'
const ID = /^[a-zA-Z0-9-]{1,128}$/

export function readBatchOrders(chatKey: string, storage: Pick<Storage, 'getItem'>): BatchStore {
  try {
    const parsed = JSON.parse(storage.getItem(keyOf(chatKey)) ?? '{}') as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: BatchStore = {}
    for (const [actionId, raw] of Object.entries(parsed)) {
      const ref = raw as Partial<BatchOrderRef>
      if (typeof ref?.order_id !== 'string' || !ID.test(ref.order_id)) continue
      result[actionId] = {
        order_id: ref.order_id,
        order_number: typeof ref.order_number === 'number' ? ref.order_number : null,
        customer_id: typeof ref.customer_id === 'string' && ID.test(ref.customer_id) ? ref.customer_id : null,
        customer_created: ref.customer_created === true,
      }
    }
    return result
  } catch { return {} }
}

export function rememberBatchOrder(chatKey: string, storage: Pick<Storage, 'getItem' | 'setItem'>, actionId: string, result: Record<string, unknown> | null | undefined): void {
  if (!result || typeof result.id !== 'string' || !ID.test(result.id)) return
  try {
    const store = readBatchOrders(chatKey, storage)
    store[actionId] = {
      order_id: result.id,
      order_number: typeof result.order_number === 'number' ? result.order_number : null,
      customer_id: typeof result.customer_id === 'string' && ID.test(result.customer_id) ? result.customer_id : null,
      customer_created: result.customer_created === true,
    }
    storage.setItem(keyOf(chatKey), JSON.stringify(store))
  } catch { /* без памʼяті пачки кнопки скасування просто не буде */ }
}

export function forgetBatchOrders(chatKey: string, storage: Pick<Storage, 'getItem' | 'setItem'>, actionIds: readonly string[]): void {
  try {
    const store = readBatchOrders(chatKey, storage)
    for (const id of actionIds) delete store[id]
    storage.setItem(keyOf(chatKey), JSON.stringify(store))
  } catch { /* нічого */ }
}

/** Пачка одного повідомлення: замовлення й лише ті клієнти, яких ця загрузка завела. */
export function batchOf(actionIds: readonly string[], store: BatchStore): { actionIds: string[]; order_ids: string[]; customer_ids: string[]; numbers: number[] } {
  const refs = actionIds.map(id => [id, store[id]] as const).filter((pair): pair is readonly [string, BatchOrderRef] => Boolean(pair[1]))
  return {
    actionIds: refs.map(([id]) => id),
    order_ids: [...new Set(refs.map(([, ref]) => ref.order_id))],
    customer_ids: [...new Set(refs.filter(([, ref]) => ref.customer_created && ref.customer_id).map(([, ref]) => ref.customer_id!))],
    numbers: refs.map(([, ref]) => ref.order_number).filter((value): value is number => value !== null),
  }
}
