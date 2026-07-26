import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import type { CustomerOrder } from '@/features/orders/orderApi'

export interface EnrichedOrderItem {
  id: string
  order_id: string
  name: string
  sku: string | null
  product_id: string | null
  supplier_id: string | null
  source_type: 'warehouse' | 'supplier'
  item_status: 'pending' | 'ordered' | 'arrived' | 'handed' | 'canceled'
  buy_price: number
  sell_price: number
  qty: number
  expected_date: string | null
  storage_bin: string | null
}

export interface EnrichedCustomerOrder extends Omit<CustomerOrder, 'items'> {
  items: EnrichedOrderItem[]
}

function enrich(order: any): EnrichedCustomerOrder {
  return {
    ...order,
    items: (order.items ?? []).map((item: any) => ({ ...item, storage_bin: item.storage_bin ?? null })),
  }
}

// У чергу збірки — лише ПІДТВЕРДЖЕНІ замовлення («В замовлення» → 'ordered' і далі).
// Відкриті (lead/new), що чекають відповіді клієнта, сюди не потрапляють.
const PICKING_STATUSES = ['ordered', 'in_progress', 'arrived', 'called', 'no_answer', 'ready']
async function localOrders(): Promise<EnrichedCustomerOrder[]> {
  const orders = desktopBridge()?.orders
  if (!orders?.list) return []
  const rows = await orders.list({ limit: 500, offset: 0 })
  return (rows ?? [])
    .filter((order: any) => PICKING_STATUSES.includes(order.status))
    .map(enrich)
}

export const pickingApi = {
  listOrders: async () => {
    if (desktopBridge()?.orders?.list) return { data: await localOrders() }
    return api.get<{ data: EnrichedCustomerOrder[] }>('/api/v1/picking/orders')
  },

  getOrderDetails: async (id: string) => {
    const local = desktopBridge()?.orders?.get
    if (local) {
      const order = await local(id)
      if (!order) throw new Error('Замовлення не знайдено')
      return { data: enrich(order) }
    }
    return api.get<{ data: EnrichedCustomerOrder }>(`/api/v1/picking/orders/${id}`)
  },

  pickItem: async (itemId: string, status: 'pending' | 'arrived') => {
    const local = desktopBridge()?.orders
    if (local?.list && local.updateItemStatus) {
      const order = (await localOrders()).find((row) => row.items.some((item) => item.id === itemId))
      if (!order) throw new Error('Позицію замовлення не знайдено')
      await local.updateItemStatus(order.id, itemId, status)
      requestDesktopSync()
      return { data: { success: true } }
    }
    return api.patch<{ data: { success: boolean } }>(`/api/v1/picking/items/${itemId}`, { item_status: status })
  },

  updatePickupCell: async (orderId: string, pickupCell: string) => {
    const local = desktopBridge()?.orders
    if (local?.get && local.save && local.updateStatus) {
      const order = await local.get(orderId)
      if (!order) throw new Error('Замовлення не знайдено')
      await local.save({ ...order, pickup_cell: pickupCell }, orderId)
      await local.updateStatus(orderId, 'ready')
      requestDesktopSync()
      return { data: { success: true } }
    }
    return api.patch<{ data: { success: boolean } }>(`/api/v1/picking/orders/${orderId}/pickup-cell`, { pickup_cell: pickupCell })
  },
}
