import { api } from '@/lib/api'
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
  storage_bin: string | null // Обогащено с бэкенда
}

export interface EnrichedCustomerOrder extends Omit<CustomerOrder, 'items'> {
  items: EnrichedOrderItem[]
}

export const pickingApi = {
  listOrders: () =>
    api.get<{ data: EnrichedCustomerOrder[] }>('/api/v1/picking/orders'),

  getOrderDetails: (id: string) =>
    api.get<{ data: EnrichedCustomerOrder }>(`/api/v1/picking/orders/${id}`),

  pickItem: (itemId: string, status: 'pending' | 'arrived') =>
    api.patch<{ data: { success: boolean } }>(`/api/v1/picking/items/${itemId}`, { item_status: status }),

  updatePickupCell: (orderId: string, pickupCell: string) =>
    api.patch<{ data: { success: boolean } }>(`/api/v1/picking/orders/${orderId}/pickup-cell`, { pickup_cell: pickupCell }),
}
