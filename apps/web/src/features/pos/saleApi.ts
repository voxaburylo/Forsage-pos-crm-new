import { api, type RequestOptions } from '@/lib/api'
import type { Sale, PriceCalculation } from '@/types/sale'
import { desktopBridge } from '@/lib/desktopBridge'
import { moneyOnlyAtTill } from '@/lib/moneyOnlyAtTill'

interface CreateSaleBody {
  shift_id: string
  customer_id?: string | null
  customer_order_id?: string | null
  manager_id?: string | null
  items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  discount?: number
  notes?: string
  cash_amount?: number
  card_amount?: number
  is_fiscal?: boolean
  terminal_auth_code?: string | null
}

type SaleRequestOptions = Pick<RequestOptions, 'silent' | 'timeoutMs'>

const SALE_READ_TIMEOUT_MS = 10_000

export const saleApi = {
  // 24.11.2026 (план T9): продаж проводить лише каса (desktop.pos.checkout у usePOS); запису продажу на сервер немає.
  create: async (_body: CreateSaleBody, _idempotencyKey?: string): Promise<{ data: Sale }> => moneyOnlyAtTill(),

  get: async (id: string, opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.getSale
    if (local) return { data: await local(id) as Sale }
    return api.get<{ data: Sale }>(`/api/v1/sales/${id}`, { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts })
  },

  list: async (
    params: Record<string, string | number | undefined> = {},
    opts: Pick<RequestOptions, 'silent' | 'timeoutMs'> = {},
  ) => {
    const local = desktopBridge()?.pos.listSales
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)) })
    const result = local
      ? await local(params) as { data: Sale[]; pagination: unknown; filter_version?: number }
      : await api.get<{ data: Sale[]; pagination: unknown; filter_version?: number }>(`/api/v1/sales?${q}`, opts)
    if (params.history_filter_version === '1' && result.filter_version !== 1) {
      throw new Error('Ця версія джерела ще не підтримує фільтри чеків. Оновіть сервер або програму; неповний список не показано.')
    }
    return result
  },

  calculatePrice: async (items: Array<{ product_id: string; qty: number }>, opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.calculatePrices
    if (local) return { data: await local(items) as PriceCalculation[] }
    return api.post<{ data: PriceCalculation[] }>('/api/v1/sales/calculate-price', { items }, undefined, { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts })
  },

  suspend: async (body: {
    confirmed_by_cashier: true
    shift_id: string; customer_id?: string | null; manager_id?: string | null
    items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
    payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
    notes?: string; pickup_cell?: string | null; expires_at?: string
  }, _idempotencyKey: string, _opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.suspendSale
    if (local) {
      const result = await local(body)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return result as { data: Sale }
    }
    return moneyOnlyAtTill()
  },

  listSuspended: async (opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.listSuspended
    if (local) return { data: await local() as Sale[] }
    return api.get<{ data: Sale[] }>('/api/v1/sales/suspended', { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts })
  },

  checkAfterPayment: async (shiftId: string, after: string, opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.checkSaleAfterPayment
    if (local) return { data: await local(shiftId, after) as Sale | null }
    return api.get<{ data: Sale | null }>(`/api/v1/sales/check-after-payment?shift_id=${shiftId}&after=${encodeURIComponent(after)}`, { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts })
  },

  resume: async (id: string, _opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.resumeSale
    if (local) return local(id) as Promise<{ data: Sale }>
    return moneyOnlyAtTill()
  },

  confirmResume: async (id: string, _opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.confirmResumeSale
    if (local) {
      const result = await local(id)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return result as { data: Pick<Sale, 'id' | 'sale_number' | 'total' | 'status'> }
    }
    return moneyOnlyAtTill()
  },

  discardSuspended: async (id: string, _opts: SaleRequestOptions = {}) => {
    const local = desktopBridge()?.pos.discardSuspendedSale
    if (local) {
      const result = await local(id)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return result as { data: Pick<Sale, 'id' | 'sale_number' | 'total' | 'status'> }
    }
    return moneyOnlyAtTill()
  },
}
