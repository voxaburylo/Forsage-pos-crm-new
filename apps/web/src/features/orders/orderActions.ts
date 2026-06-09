interface RepeatableItem {
  name: string
  sku?: string | null
  qty?: number
  sell_price?: number
  supplier_id?: string | null
  product_id?: string | null
  expected_date?: string | null
}

interface RepeatableOrder {
  customer_id?: string | null
  vehicle_info?: unknown
  discount_amount?: number
  items?: RepeatableItem[]
}

/**
 * Готує payload для повторення замовлення (ORD-2) і кладе його в sessionStorage.
 * OrderFormPage при відкритті /orders/new зчитує його й заповнює форму
 * (клієнт, авто, позиції, знижка) — менеджеру лишається тільки підтвердити.
 */
export function startRepeatOrder(
  order: RepeatableOrder,
  navigate: (path: string) => void,
) {
  const payload = {
    customer_id: order.customer_id ?? null,
    vehicle_info: order.vehicle_info ?? null,
    discount_amount: order.discount_amount ?? 0,
    items: (order.items ?? []).map((it) => ({
      name: it.name,
      sku: it.sku ?? '',
      qty: String(it.qty ?? 1),
      sell_price: ((it.sell_price ?? 0) / 100).toFixed(2),
      supplier_id: it.supplier_id ?? '',
      product_id: it.product_id ?? null,
      expected_date: it.expected_date ? it.expected_date.split('T')[0] : '',
    })),
  }
  sessionStorage.setItem('duplicate_order_payload', JSON.stringify(payload))
  navigate('/orders/new')
}
