import { api, type RequestOptions } from '@/lib/api'

// ---------- Типи ----------

export type CustomerOrderStatus = 'lead' | 'new' | 'in_progress' | 'ordered' | 'arrived' | 'called' | 'no_answer' | 'ready' | 'completed' | 'canceled'
export type ItemStatus = 'pending' | 'ordered' | 'arrived' | 'handed' | 'canceled' | 'returned'
export type OrderSource = 'walk_in' | 'phone' | 'messenger' | 'telegram_bot' | 'mobile_draft'

export interface CustomerOrderItem {
  id: string
  order_id: string
  name: string
  sku: string | null
  product_id: string | null
  supplier_id: string | null
  source_type: 'warehouse' | 'supplier'
  item_type: 'product' | 'service'
  item_status: ItemStatus
  buy_price: number
  sell_price: number
  qty: number
  expected_date: string | null
}

export interface CustomerOrder {
  id: string
  order_number: number | null
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
  discount_amount: number
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
  id?: string // наявна позиція — щоб сервер зберіг її статус при редагуванні
  name: string
  sku?: string | null
  product_id?: string | null
  supplier_id?: string | null
  source_type?: 'warehouse' | 'supplier'
  item_type?: 'product' | 'service'
  buy_price?: number
  sell_price: number
  qty: number
  expected_date?: string | null
  is_draft_note?: boolean
  item_status?: ItemStatus
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
  parent_draft_id?: string | null
  discount_amount?: number
  items: CreateOrderItemPayload[]
}

// ---------- API ----------

type OrderRequestOptions = Pick<RequestOptions, 'silent' | 'timeoutMs'>

const ORDER_READ_TIMEOUT_MS = 10_000
const ORDER_WRITE_TIMEOUT_MS = 15_000
const ORDER_FINALIZE_TIMEOUT_MS = 30_000

export const orderApi = {
  list: (offset = 0, opts: OrderRequestOptions = {}) =>
    api.get<{ data: CustomerOrder[] }>(
      `/api/v1/customer-orders?per_page=200&offset=${offset}`,
      { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts },
    ),

  get: (id: string, opts: OrderRequestOptions = {}) =>
    api.get<{ data: CustomerOrder }>('/api/v1/customer-orders/' + id, { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts }),

  create: (body: CreateOrderPayload, opts: OrderRequestOptions = {}) =>
    api.post<{ data: CustomerOrder }>('/api/v1/customer-orders', body, undefined, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts }),

  update: (id: string, body: CreateOrderPayload, opts: OrderRequestOptions = {}) =>
    api.put<{ data: CustomerOrder }>('/api/v1/customer-orders/' + id, body, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts }),

  delete: (id: string, opts: OrderRequestOptions = {}) =>
    api.delete<{ data: { success: boolean } }>('/api/v1/customer-orders/' + id, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts }),

  updateStatus: (id: string, status: CustomerOrderStatus, callback_at?: string | null, opts: OrderRequestOptions = {}) =>
    api.patch<{ data: CustomerOrder }>(`/api/v1/customer-orders/${id}/status`, { status, callback_at }, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts }),

  updateItemStatus: (orderId: string, itemId: string, item_status: ItemStatus, opts: OrderRequestOptions = {}) =>
    api.patch(`/api/v1/customer-orders/${orderId}/items/${itemId}/status`, { item_status }, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts }),

  complete: (id: string, payload: { payment_method: string; is_fiscal: boolean; shift_id: string | null }, opts: OrderRequestOptions = {}) =>
    api.post(`/api/v1/customer-orders/${id}/complete`, payload, undefined, { timeoutMs: ORDER_FINALIZE_TIMEOUT_MS, ...opts }),

  cancel: (id: string, refund_prepayment: boolean, reason?: string | null, keep_as_credit?: boolean, opts: OrderRequestOptions = {}) =>
    api.post(`/api/v1/customer-orders/${id}/cancel`, { refund_prepayment, keep_as_credit: keep_as_credit ?? false, reason: reason ?? null }, undefined, { timeoutMs: ORDER_FINALIZE_TIMEOUT_MS, ...opts }),

  pendingItems: (supplierId: string, opts: OrderRequestOptions = {}) =>
    api.get<{ data: any[] }>(`/api/v1/customer-orders/pending-items?supplier_id=${supplierId}`, { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts }),

  bulkArrival: (item_ids: string[], opts: OrderRequestOptions = {}) =>
    api.post('/api/v1/customer-orders/bulk-arrival', { item_ids }, undefined, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts }),
}
