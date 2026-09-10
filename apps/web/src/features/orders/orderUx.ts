import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'

// Contact outcomes do not move a ready order back to the supply queue.
export const READY_ORDER_STATUSES = ['ready', 'arrived', 'called', 'no_answer']
export const WORK_ORDER_STATUSES = ['new', 'in_progress', 'ordered']
export const isReadyOrderStatus = (status: string) => READY_ORDER_STATUSES.includes(status)
export const isWorkOrderStatus = (status: string) => WORK_ORDER_STATUSES.includes(status)
export const canUseOrderCash = (role: string | undefined) => ['owner', 'admin', 'cashier'].includes(role ?? '')

export function orderEditPath(order: { id: string; items: Array<{ is_draft_note?: boolean }> }): string {
  return order.items.some((item) => item.is_draft_note) ? `/quotes/${order.id}` : `/orders/${order.id}/edit`
}

export function availableStock(product: Pick<Product, 'qty_available' | 'qty_on_hand'>): number {
  return Math.max(0, Number(product.qty_available ?? product.qty_on_hand) || 0)
}

export function stockFirst<T extends Pick<Product, 'qty_available' | 'qty_on_hand'>>(products: T[]): T[] {
  // Preserve the catalogue's relevance order within each availability group.
  return [...products].sort((a, b) => Number(availableStock(b) > 0) - Number(availableStock(a) > 0))
}

export function replaceOrderProduct<T extends { qty: string; sell_price: string; product_id?: string | null }>(row: T, product: Product) {
  // Searching the same reserved product may report zero available stock: it is
  // already reserved by this order. Reselecting it must not turn it into a backorder.
  if (row.product_id === product.id) return row
  const stock = availableStock(product)
  return {
    ...row, product_id: product.id, name: product.name, sku: product.sku ?? '', stock,
    buy_price: kopecksToHryvnia(product.purchase_price ?? 0), supplier_id: '', expected_date: '',
    item_status: 'pending' as const,
    source_type: stock >= orderNumber(row.qty) || product.is_service ? 'warehouse' as const : 'supplier' as const,
    item_type: product.is_service ? 'service' as const : 'product' as const,
  }
}

export function orderNumber(value: string): number {
  return Number(value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'))
}

export function validateOrderRows(rows: Array<{ name: string; qty: string; sell_price: string; buy_price?: string; stock?: number; source_type?: string; item_type?: string }>): string | null {
  for (const [index, row] of rows.entries()) {
    const prefix = `Рядок ${index + 1} «${row.name.trim()}»:`
    const qty = orderNumber(row.qty)
    if (!row.qty.trim() || !Number.isFinite(qty) || qty <= 0) return `${prefix} вкажіть кількість більше нуля`
    for (const [label, value] of [['продажу', row.sell_price], ['закупки', row.buy_price ?? '0']]) {
      if (!value.trim() || !Number.isFinite(orderNumber(value)) || orderNumber(value) < 0) return `${prefix} перевірте ціну ${label}`
    }
    if (row.source_type === 'warehouse' && row.item_type !== 'service' && row.stock !== undefined && qty > row.stock) {
      return `${prefix} доступно ${row.stock}, потрібно ${qty}. Зменшіть кількість або виберіть «Під замовлення».`
    }
  }
  return null
}
