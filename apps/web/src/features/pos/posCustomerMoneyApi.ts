import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import { useAuthStore } from '@/stores/authStore'

const READ_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 20_000

type Options = { silent?: boolean; timeoutMs?: number }
type MoneyMethod = 'cash' | 'card' | 'transfer'

function userId(): string | undefined {
  return useAuthStore.getState().session?.user?.id ?? undefined
}

function localPos() {
  return desktopBridge()?.pos ?? null
}

export interface PosMoneyCustomer {
  id: string
  full_name: string | null
  phone: string | null
  debt_balance: number
  deposit_balance?: number
}

export const posCustomerMoneyApi = {
  listDebtors: async (limit = 100, opts: Options = {}) => {
    const local = localPos()
    if (local?.listDebtors) return { data: await local.listDebtors(limit) as PosMoneyCustomer[] }
    return api.get<{ data: PosMoneyCustomer[] }>(`/api/v1/customers?has_debt=true&sort=debt&per_page=${limit}`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS,
    })
  },

  searchCustomers: async (input: { search?: string; has_debt?: boolean; limit?: number }, opts: Options = {}) => {
    const local = localPos()
    if (local?.searchCustomers) return { data: await local.searchCustomers(input) as PosMoneyCustomer[] }
    const params = new URLSearchParams()
    if (input.search?.trim()) params.set('search', input.search.trim())
    if (input.has_debt) params.set('has_debt', 'true')
    params.set('per_page', String(input.limit ?? 50))
    return api.get<{ data: PosMoneyCustomer[] }>(`/api/v1/customers?${params.toString()}`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS,
    })
  },

  getDeposit: async (customerId: string, opts: Options = {}) => {
    const local = localPos()
    if (local?.getCustomerDeposit) return { data: await local.getCustomerDeposit(customerId) }
    return api.get<{ data: { balance: number; transactions: unknown[] } }>(`/api/v1/customers/${customerId}/deposit`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS,
    })
  },

  payDebt: async (customerId: string, body: { amount: number; method: MoneyMethod; shift_id?: string | null; notes?: string | null }, opts: Options = {}) => {
    const local = localPos()
    if (local?.payDebt) {
      const result = await local.payDebt({ ...body, customer_id: customerId, user_id: userId() })
      requestDesktopSync()
      return result
    }
    return api.post(`/api/v1/customers/${customerId}/pay-debt`, body, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? WRITE_TIMEOUT_MS,
    })
  },

  addDeposit: async (customerId: string, body: { amount: number; method: MoneyMethod; shift_id?: string | null; notes?: string | null }, opts: Options = {}) => {
    const local = localPos()
    if (local?.addCustomerDeposit) {
      const result = await local.addCustomerDeposit({ ...body, customer_id: customerId, user_id: userId() })
      requestDesktopSync()
      return result
    }
    return api.post<{ data: { balance: number } }>(`/api/v1/customers/${customerId}/deposit`, body, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? WRITE_TIMEOUT_MS,
    })
  },
}