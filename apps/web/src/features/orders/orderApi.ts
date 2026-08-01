import { api, type RequestOptions } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'

// ---------- Типи ----------

export type CustomerOrderStatus = 'lead' | 'quoted' | 'new' | 'in_progress' | 'ordered' | 'arrived' | 'called' | 'no_answer' | 'ready' | 'completed' | 'canceled' | 'archived'
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
  sale_id: string | null
  exchange_source_order_id?: string | null
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
  exchange_source_order_id?: string | null
  items: CreateOrderItemPayload[]
}

// ---------- API ----------

type OrderRequestOptions = Pick<RequestOptions, 'silent' | 'timeoutMs'>

const ORDER_READ_TIMEOUT_MS = 10_000
const ORDER_WRITE_TIMEOUT_MS = 15_000
const ORDER_FINALIZE_TIMEOUT_MS = 30_000

function requestOrderSync() {
  window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
}

export const orderApi = {
  list: async (offset = 0, opts: OrderRequestOptions = {}, limit = 200) => {
    const local = desktopBridge()?.orders?.list
    if (local) return { data: await local({ offset, limit }) as CustomerOrder[] }
    return api.get<{ data: CustomerOrder[] }>(
      `/api/v1/customer-orders?per_page=${limit}&offset=${offset}`,
      { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts },
    )
  },

  get: async (id: string, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.get
    if (local) {
      const data = await local(id)
      if (!data) throw new Error('Замовлення не знайдено')
      return { data: data as CustomerOrder }
    }
    return api.get<{ data: CustomerOrder }>('/api/v1/customer-orders/' + id, { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts })
  },

  create: async (body: CreateOrderPayload, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.save
    if (local) {
      const data = await local(body)
      requestOrderSync()
      return { data: data as CustomerOrder }
    }
    return api.post<{ data: CustomerOrder }>('/api/v1/customer-orders', body, undefined, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts })
  },

  createExchange: async (sourceOrder: CustomerOrder, opts: OrderRequestOptions = {}) => {
    return orderApi.create({
      customer_id: sourceOrder.customer_id,
      vehicle_info: sourceOrder.vehicle_info,
      source: 'walk_in',
      exchange_source_order_id: sourceOrder.id,
      comment: `Обмін до замовлення ${sourceOrder.order_number ? '#' + sourceOrder.order_number : sourceOrder.id.slice(0, 8)}`,
      items: (sourceOrder.items ?? [])
        .filter((item) => item.item_status !== 'canceled')
        .map((item) => ({
          name: item.name,
          sku: item.sku,
          product_id: item.product_id,
          supplier_id: item.supplier_id,
          source_type: item.source_type,
          item_type: item.item_type,
          buy_price: item.buy_price,
          sell_price: item.sell_price,
          qty: item.qty,
          expected_date: item.expected_date,
        })),
    }, opts)
  },
  update: async (id: string, body: CreateOrderPayload, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.save
    if (local) {
      const data = await local(body, id)
      requestOrderSync()
      return { data: data as CustomerOrder }
    }
    return api.put<{ data: CustomerOrder }>('/api/v1/customer-orders/' + id, body, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts })
  },

  delete: async (id: string, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.delete
    if (local) {
      const data = await local(id)
      requestOrderSync()
      return { data }
    }
    return api.delete<{ data: { success: boolean } }>('/api/v1/customer-orders/' + id, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts })
  },

  updateStatus: async (id: string, status: CustomerOrderStatus, callback_at?: string | null, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.updateStatus
    if (local) {
      const data = await local(id, status)
      requestOrderSync()
      return { data: data as CustomerOrder }
    }
    return api.patch<{ data: CustomerOrder }>(`/api/v1/customer-orders/${id}/status`, { status, callback_at }, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts })
  },

  updateItemStatus: async (orderId: string, itemId: string, item_status: ItemStatus, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.updateItemStatus
    if (local) {
      const data = await local(orderId, itemId, item_status)
      requestOrderSync()
      return { data }
    }
    return api.patch(`/api/v1/customer-orders/${orderId}/items/${itemId}/status`, { item_status }, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts })
  },

  listPayments: async (id: string, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.listPayments
    if (local) return { data: await local(id) }
    return api.get<{ data: any[] }>(`/api/v1/customer-orders/${id}/payments`, { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts })
  },
  complete: async (id: string, payload: { payment_method: string; is_fiscal: boolean; shift_id: string | null }, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.complete
    if (local) {
      const data = await local(id, payload)
      requestOrderSync()
      return data
    }
    return api.post(`/api/v1/customer-orders/${id}/complete`, payload, undefined, { timeoutMs: ORDER_FINALIZE_TIMEOUT_MS, ...opts })
  },

  cancel: async (id: string, refund_prepayment: boolean, reason?: string | null, keep_as_credit?: boolean, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.cancel
    if (local) {
      const data = await local(id, { refund_prepayment, keep_as_credit: keep_as_credit ?? false, reason: reason ?? null })
      requestOrderSync()
      return { data }
    }
    return api.post(`/api/v1/customer-orders/${id}/cancel`, { refund_prepayment, keep_as_credit: keep_as_credit ?? false, reason: reason ?? null }, undefined, { timeoutMs: ORDER_FINALIZE_TIMEOUT_MS, ...opts })
  },

  pendingItems: async (supplierId: string, opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.pendingItems
    if (local) return { data: await local(supplierId) }
    return api.get<{ data: any[] }>(`/api/v1/customer-orders/pending-items?supplier_id=${supplierId}`, { timeoutMs: ORDER_READ_TIMEOUT_MS, ...opts })
  },

  bulkArrival: async (item_ids: string[], opts: OrderRequestOptions = {}) => {
    const local = desktopBridge()?.orders?.bulkArrival
    if (local) {
      const data = await local(item_ids)
      requestOrderSync()
      return { data }
    }
    return api.post('/api/v1/customer-orders/bulk-arrival', { item_ids }, undefined, { timeoutMs: ORDER_WRITE_TIMEOUT_MS, ...opts })
  },
}
