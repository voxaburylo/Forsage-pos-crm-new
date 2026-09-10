import { desktopBridge } from '@/lib/desktopBridge'
import { orderApi, type CreateOrderPayload } from '@/features/orders/orderApi'
import { customerApi } from '@/features/customers/customerApi'
import { parseCustomerMoney } from '@/features/customers/customerUi'

export function aiOrderPayload(payload: Record<string, any>): CreateOrderPayload {
  const price = (raw: unknown): number => {
    if (raw == null || raw === '') return 0
    const parsed = parseCustomerMoney(String(raw))
    if (parsed === null) throw new Error('Перевірте ціни розпізнаних позицій')
    return parsed
  }
  const year = payload.car_year == null || payload.car_year === '' ? undefined : Number(payload.car_year)
  if (year !== undefined && (!Number.isInteger(year) || year < 1886 || year > new Date().getFullYear() + 2)) throw new Error('Перевірте рік автомобіля')
  const vin = String(payload.vin ?? '').trim().toUpperCase()
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('Перевірте VIN: потрібно 17 символів без I, O та Q')
  return {
    source: 'walk_in',
    vehicle_info: { make: String(payload.car_make ?? '').trim(), model: String(payload.car_model ?? '').trim(), year, vin },
    comment: [String(payload.comment ?? '').trim(), payload.plate ? `Держномер: ${String(payload.plate).trim()}` : '',
      !payload.customer_phone && payload.customer_name ? `Клієнт: ${String(payload.customer_name).trim()}` : ''].filter(Boolean).join('\n') || null,
    items: (Array.isArray(payload.items) ? payload.items : []).map((item: any) => {
      const name = String(item.name ?? '').trim()
      const qtyText = String(item.qty ?? '').trim().replace(',', '.')
      const qty = Number(qtyText)
      if (!name || !/^\d+(?:\.\d{1,3})?$/.test(qtyText) || !Number.isFinite(qty) || qty <= 0) throw new Error('Перевірте назву та кількість кожної позиції')
      return { name, sku: String(item.part_number ?? '').trim() || null, qty,
        sell_price: price(item.sell_price_uah), buy_price: price(item.buy_price_uah),
        source_type: 'supplier' as const, item_status: item.arrived === true ? 'arrived' as const : 'pending' as const }
    }),
  }
}

// Recognition may use a remote AI; confirmed business writes must stay in SQLite.
export async function applyLocalAiAction(tool: string, payload: Record<string, any>) {
  const bridge = desktopBridge()
  if (!bridge?.orders?.save || !bridge.pos?.saveCustomer) throw new Error('Локальна база недоступна. Дію не виконано.')
  if (tool !== 'create_order') throw new Error('Ця дія ШІ ще не підтримує локальний запис. Дані не змінено. Для товарів використайте звичайну накладну або накладну з фото.')
  const body = aiOrderPayload(payload)
  const phone = String(payload.customer_phone ?? '').trim()
  let customerCreated = false
  if (phone) {
    const customer = await customerApi.quickCreate(phone, String(payload.customer_name ?? '').trim())
    body.customer_id = customer.data.id
    customerCreated = !customer.meta?.reused
  }
  const order = await orderApi.create(body)
  return { data: { result: { ...order.data, customer_created: customerCreated } } }
}
