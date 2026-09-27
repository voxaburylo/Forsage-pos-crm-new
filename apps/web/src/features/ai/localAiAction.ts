import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { orderApi, type CreateOrderPayload } from '@/features/orders/orderApi'
import { customerApi } from '@/features/customers/customerApi'
import { readSupplyNumber } from './aiSupplyNumber'
import { assertAiOrderShape } from './aiOrderShape'
import { assertAiWriteAllowed } from './aiWritePolicy'

export function aiOrderPayload(payload: Record<string, any>): CreateOrderPayload {
  assertAiOrderShape(payload)
  const price = (raw: unknown): number => {
    if (raw == null || raw === '') return 0
    try { return Math.round(readSupplyNumber(raw, 'price', 'Замовлення') * 100) }
    catch { throw new Error('Перевірте ціни розпізнаних позицій. Значення не підмінено.') }
  }
  const year = payload.car_year == null || payload.car_year === '' ? undefined : Number(payload.car_year)
  if (year !== undefined && (!Number.isInteger(year) || year < 1886 || year > new Date().getFullYear() + 2)) throw new Error('Перевірте рік автомобіля')
  const vin = String(payload.vin ?? '').trim().toUpperCase()
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('Перевірте VIN: потрібно 17 символів без I, O та Q')
  const body: CreateOrderPayload = {
    source: 'walk_in',
    vehicle_info: { make: String(payload.car_make ?? '').trim(), model: String(payload.car_model ?? '').trim(), year, vin },
    comment: [String(payload.comment ?? '').trim(), payload.plate ? `Держномер: ${String(payload.plate).trim()}` : '',
      !payload.customer_phone && payload.customer_name ? `Клієнт: ${String(payload.customer_name).trim()}` : ''].filter(Boolean).join('\n') || null,
    items: (Array.isArray(payload.items) ? payload.items : []).map((item: any) => {
      const name = String(item.name ?? '').trim()
      const qtyText = String(item.qty ?? '').trim().replace(',', '.')
      const qty = Number(qtyText)
      if (!name || !/^\d+(?:\.\d{1,3})?$/.test(qtyText) || !Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) throw new Error('Перевірте назву та кількість кожної позиції')
      return { name, sku: String(item.part_number ?? '').trim() || null, qty,
        sell_price: price(item.sell_price_uah), buy_price: price(item.buy_price_uah),
        source_type: 'supplier' as const, item_status: item.arrived === true ? 'arrived' as const : 'pending' as const }
    }),
  }
  for (const field of ['sell_price', 'buy_price'] as const) {
    const total = body.items.reduce((sum, item) => sum + Math.round(item.qty * (item[field] ?? 0)), 0)
    if (!Number.isSafeInteger(total) || total > 2_147_483_647) throw new Error('Сума замовлення завелика. Перевірте кількість і ціни.')
  }
  return body
}

// Recognition may use a remote AI; confirmed business writes must stay in SQLite.
export async function applyLocalAiAction(tool: string, payload: Record<string, any>, operationId?: string) {
  const bridge = desktopBridge()
  if (!bridge?.orders?.save || !bridge.pos?.saveCustomer) throw new Error('Локальна база недоступна. Дію не виконано.')
  if (tool !== 'create_order') throw new Error('Ця дія ШІ ще не підтримує локальний запис. Дані не змінено. Для товарів використайте звичайну накладну або накладну з фото.')
  const identity = () => { const user = useAuthStore.getState().session?.user; return user ? JSON.stringify([user.id, user.app_metadata?.tenant_id ?? 'local']) : null }
  const actor = identity()
  if (!actor) throw new Error('Увійдіть у програму перед підтвердженням замовлення')
  assertAiWriteAllowed(tool, useAuthStore.getState().session?.user.app_metadata?.role, true)
  const body = aiOrderPayload(payload)
  if (operationId !== undefined) {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw new Error('Некоректний номер операції замовлення')
    body.operation_id = operationId
  }
  const phone = String(payload.customer_phone ?? '').trim()
  let customerCreated = false
  if (phone) {
    const customer = await customerApi.quickCreate(phone, String(payload.customer_name ?? '').trim())
    body.customer_id = customer.data.id
    customerCreated = !customer.meta?.reused
  }
  if (identity() !== actor) throw new Error('Користувач змінився. Замовлення не створено; перевірте дію у своєму акаунті.')
  assertAiWriteAllowed(tool, useAuthStore.getState().session?.user.app_metadata?.role, true)
  const order = await orderApi.create(body)
  return { data: { result: { ...order.data, customer_created: customerCreated } } }
}
