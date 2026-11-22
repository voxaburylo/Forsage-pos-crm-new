import type { CreateOrderPayload } from '@/features/orders/orderApi'

/**
 * Замовлення з вебу (телефон) через касу — етап 8 плану замовлень.
 * Веб лише передає бланк; замовлення створює каса у своїй базі під тим самим номером операції,
 * тож подвійне натискання чи обрив зв'язку не дають двох замовлень. Грошей тут немає:
 * передоплата, оплата й видача — тільки на касі. Ціни — у копійках.
 */
export interface TillOrderItem {
  name: string; sku?: string | null; qty: number; sell_price: number; buy_price?: number
  /** Картка зі складу, вибрана у вебі. Каса бере назву, артикул і закупку зі СВОЄЇ картки, а не з вебу. */
  product_id?: string | null
}
/** Картка товару на касі — лише те, що потрібно замовленню. */
export interface TillOrderCard { id: string; name: string; sku: string; retail_price: number; purchase_price: number; is_active?: number | boolean; is_service?: number | boolean }
export interface TillOrderPayload {
  customer_phone?: string | null
  customer_name?: string | null
  car_make?: string | null
  car_model?: string | null
  car_year?: number | null
  vin?: string | null
  comment?: string | null
  /** Хто оформив у вебі — лише для примітки в замовленні. */
  author?: string | null
  items: TillOrderItem[]
}

export const TILL_ORDER_MAX_ITEMS = 60
const MAX_KOPECKS = 100_000_000

const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)

/** Телефон у вигляді, який приймає картка клієнта: лише цифри, 10–12 знаків. Порожній — клієнта не вказано. */
export function normalizeOrderPhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length < 10 || digits.length > 12) throw new Error('Перевірте телефон клієнта: потрібно 10–12 цифр.')
  return digits
}

/** Число з поля форми («2», «1,5») — або помилка зі зрозумілою причиною. Нічого не підміняємо. */
export function readOrderQty(text: string): number {
  const value = text.trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,3})?$/.test(value) || Number(value) <= 0 || Number(value) > 1_000_000) throw new Error('Перевірте кількість: потрібне число більше нуля.')
  return Number(value)
}

/** Гривні з поля форми → копійки. Порожнє поле — 0 (ціну ще не знають). */
export function readOrderMoney(text: string, label: string): number {
  const value = text.trim().replace(',', '.')
  if (!value) return 0
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`Перевірте поле «${label}»: потрібна сума, наприклад 1250 або 1250.50`)
  const [whole, fraction = ''] = value.split('.')
  const kopecks = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(kopecks) || kopecks > MAX_KOPECKS) throw new Error(`Поле «${label}»: сума завелика.`)
  return kopecks
}

/**
 * Перевірка бланка — однакова у вебі перед відправкою і на касі перед записом.
 * Каса не довіряє вебу: вона проходить ті самі правила ще раз.
 */
export function checkTillOrder(raw: unknown): TillOrderPayload {
  const input = (raw ?? {}) as Partial<TillOrderPayload>
  const items = Array.isArray(input.items) ? input.items : []
  if (!items.length) throw new Error('Додайте хоча б одну позицію.')
  if (items.length > TILL_ORDER_MAX_ITEMS) throw new Error(`Забагато позицій: не більше ${TILL_ORDER_MAX_ITEMS} в одному замовленні.`)
  const year = input.car_year == null ? null : Number(input.car_year)
  if (year !== null && (!Number.isInteger(year) || year < 1886 || year > new Date().getFullYear() + 2)) throw new Error('Перевірте рік автомобіля.')
  const vin = clean(input.vin, 17).toUpperCase()
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('Перевірте VIN: потрібно 17 символів без I, O та Q.')
  const phone = normalizeOrderPhone(input.customer_phone)
  const name = clean(input.customer_name, 120)
  if (!phone && !name) throw new Error('Вкажіть телефон або ім’я клієнта, щоб замовлення можна було знайти.')
  return {
    customer_phone: phone || null,
    customer_name: name || null,
    car_make: clean(input.car_make, 60) || null,
    car_model: clean(input.car_model, 60) || null,
    car_year: year,
    vin: vin || null,
    comment: clean(input.comment, 1000) || null,
    author: clean(input.author, 120) || null,
    items: items.map((item, index) => {
      const row = (item ?? {}) as Partial<TillOrderItem>
      const itemName = clean(row.name, 300)
      const place = `Позиція ${index + 1}`
      if (!itemName) throw new Error(`${place}: вкажіть назву.`)
      const qty = Number(row.qty)
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000 || Math.round(qty * 1000) !== qty * 1000) throw new Error(`${place}: перевірте кількість.`)
      const sell = Number(row.sell_price), buy = Number(row.buy_price ?? 0)
      for (const [value, label] of [[sell, 'ціну продажу'], [buy, 'закупку']] as const)
        if (!Number.isSafeInteger(value) || value < 0 || value > MAX_KOPECKS) throw new Error(`${place}: перевірте ${label}.`)
      // Жорстке правило власника: товар не відпускається нижче закупівельної ціни. Ціна 0 = «ще не знаємо».
      if (sell > 0 && buy > 0 && sell < buy) throw new Error(`${place}: ціна продажу нижча за закупку. Не збережено.`)
      const productId = clean(row.product_id, 36)
      if (productId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) throw new Error(`${place}: товар зі складу вибрано неправильно. Виберіть його ще раз.`)
      return { name: itemName, sku: clean(row.sku, 100) || null, qty, sell_price: sell, buy_price: buy, ...(productId ? { product_id: productId } : {}) }
    }),
  }
}

/** Бланк із вебу → звичайне створення замовлення на касі. Статус і гроші каса ставить сама (нове, без оплат). */
export function tillOrderToCreate(payload: TillOrderPayload, customerId: string | null, operationId: string, cards: ReadonlyMap<string, TillOrderCard | null> = new Map()): CreateOrderPayload {
  const order = checkTillOrder(payload)
  const items = order.items.map((item, index) => {
    if (!item.product_id) return { name: item.name, sku: item.sku ?? null, qty: item.qty, sell_price: item.sell_price,
      buy_price: item.buy_price ?? 0, source_type: 'supplier' as const }
    // Товар зі складу: правда — картка на касі. Якщо її вже немає або ціна нижча за закупку — відмова, а не тиха підміна.
    const place = `Позиція ${index + 1}`
    const card = cards.get(item.product_id)
    if (!card || card.is_active === false || card.is_active === 0) throw new Error(`${place}: товару «${item.name}» немає в базі каси (видалено або об’єднано). Оновіть сторінку й виберіть його знову.`)
    if (card.is_service === true || card.is_service === 1) throw new Error(`${place}: «${card.name}» — це послуга. Послуги додають на касі.`)
    const sell = item.sell_price > 0 ? item.sell_price : Number(card.retail_price)
    if (sell < Number(card.purchase_price)) throw new Error(`${place}: ціна продажу «${card.name}» нижча за закупівельну. Не збережено.`)
    return { name: card.name, sku: card.sku || null, product_id: card.id, qty: item.qty, sell_price: sell,
      buy_price: Number(card.purchase_price), source_type: 'warehouse' as const }
  })
  const notes = [
    order.author ? `Оформлено у вебі: ${order.author}` : 'Оформлено у вебі',
    !customerId && order.customer_name ? `Клієнт: ${order.customer_name}` : '',
    order.comment ?? '',
  ].filter(Boolean)
  return {
    operation_id: operationId,
    source: 'walk_in',
    customer_id: customerId,
    vehicle_info: { make: order.car_make ?? '', model: order.car_model ?? '', year: order.car_year ?? undefined, vin: order.vin ?? '' },
    comment: notes.join('\n'),
    items,
  }
}
