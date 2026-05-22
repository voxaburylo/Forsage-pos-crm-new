import { api } from '@/lib/api'

// ---------- Типи ----------

export type CustomerOrderStatus = 'lead' | 'new' | 'ordered' | 'arrived' | 'called' | 'no_answer' | 'ready' | 'completed' | 'canceled'
export type ItemStatus = 'pending' | 'ordered' | 'arrived' | 'handed' | 'canceled'
export type OrderSource = 'walk_in' | 'phone' | 'messenger' | 'telegram_bot' | 'mobile_draft'

export interface CustomerOrderItem {
  id: string
  order_id: string
  name: string
  sku: string | null
  product_id: string | null
  supplier_id: string | null
  source_type: 'warehouse' | 'supplier'
  item_status: ItemStatus
  buy_price: number
  sell_price: number
  qty: number
  expected_date: string | null
}

export interface CustomerOrder {
  id: string
  kp_number: string | null
  customer_id: string | null
  chat_id: string | null
  manager_id: string
  vehicle_info: { make?: string; model?: string; year?: number; vin?: string; engine_volume?: string } | null
  status: CustomerOrderStatus
  prepayment: number
  prepayment_method: string | null
  total_amount: number
  total_paid: number
  pickup_deadline_at: string | null
  pickup_cell: string | null
  comment: string | null
  source: OrderSource
  created_at: string
  updated_at: string
  sent_to_telegram_at: string | null
  customer: { id: string; phone: string; full_name: string | null } | null
  items: CustomerOrderItem[]
  activity?: Array<{ id: string; action: string; details: any; created_at: string; user_id: string | null }>
}

export interface CreateOrderItemPayload {
  name: string
  sku?: string | null
  product_id?: string | null
  supplier_id?: string | null
  source_type?: 'warehouse' | 'supplier'
  buy_price?: number
  sell_price: number
  qty: number
}

export interface CreateOrderPayload {
  customer_id?: string | null
  chat_id?: string | null
  vehicle_info?: { make?: string; model?: string; year?: number; vin?: string } | null
  comment?: string | null
  source?: OrderSource
  prepayment?: number
  prepayment_method?: 'cash' | 'card' | 'transfer' | null
  prepayment_is_fiscal?: boolean
  items: CreateOrderItemPayload[]
}

// ---------- API ----------

export const orderApi = {
  list: (offset = 0) =>
    api.get<{ data: CustomerOrder[] }>(
      `/api/v1/customer-orders?per_page=200&offset=${offset}`,
    ),

  get: (id: string) =>
    api.get<{ data: CustomerOrder }>('/api/v1/customer-orders/' + id),

  create: (body: CreateOrderPayload) =>
    api.post<{ data: CustomerOrder }>('/api/v1/customer-orders', body),

  updateStatus: (id: string, status: CustomerOrderStatus) =>
    api.patch<{ data: CustomerOrder }>(`/api/v1/customer-orders/${id}/status`, { status }),

  updateItemStatus: (orderId: string, itemId: string, item_status: ItemStatus) =>
    api.patch(`/api/v1/customer-orders/${orderId}/items/${itemId}/status`, { item_status }),

  complete: (id: string, payload: { payment_method: string; is_fiscal: boolean; shift_id: string | null }) =>
    api.post(`/api/v1/customer-orders/${id}/complete`, payload),

  cancel: (id: string, refund_prepayment: boolean, reason?: string | null, keep_as_credit?: boolean) =>
    api.post(`/api/v1/customer-orders/${id}/cancel`, { refund_prepayment, keep_as_credit: keep_as_credit ?? false, reason: reason ?? null }),

  pendingItems: (supplierId: string) =>
    api.get<{ data: any[] }>(`/api/v1/customer-orders/pending-items?supplier_id=${supplierId}`),

  bulkArrival: (item_ids: string[]) =>
    api.post('/api/v1/customer-orders/bulk-arrival', { item_ids }),
}
