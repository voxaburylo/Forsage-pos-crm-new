import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { createLocalReturn, checkLocalReturnAttempt, readLocalReturnAttempt } from './localReturnRequest'
import type {
  CustomerReturn,
  PaginatedReturns,
  SaleForReturn,
  CreateReturnBody,
} from '@/types/return'

function currentUserId(): string {
  return useAuthStore.getState().session?.user?.id ?? 'local'
}

function requestSync() {
  window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
}

function returnScope() {
  const user = useAuthStore.getState().session?.user
  return `${user?.app_metadata?.tenant_id ?? 'local'}:${currentUserId()}`
}

export const returnApi = {
  hasPending: () => Boolean(desktopBridge() && readLocalReturnAttempt(returnScope())),
  checkPending: async () => {
    const lookup = desktopBridge()?.pos.getReturnByOperation
    if (!lookup) throw new Error('Для безпечної перевірки повернення потрібна оновлена локальна програма')
    return checkLocalReturnAttempt(returnScope(), lookup)
  },
  list: async (page = 1) => {
    const local = desktopBridge()?.pos.listReturns
    if (local) return await local({ page, per_page: 20 }) as PaginatedReturns
    return api.get<PaginatedReturns>('/api/v1/returns?page=' + page + '&per_page=20')
  },

  get: async (id: string) => {
    const local = desktopBridge()?.pos.getReturn
    if (local) return { data: await local(id) as CustomerReturn }
    return api.get<{ data: CustomerReturn }>('/api/v1/returns/' + id)
  },

  getSaleItems: async (saleId: string) => {
    const local = desktopBridge()?.pos.getSaleForReturn
    if (local) return { data: await local(saleId) as SaleForReturn }
    return api.get<{ data: SaleForReturn }>('/api/v1/returns/sale/' + saleId + '/items')
  },

  create: async (body: CreateReturnBody, operationId?: string) => {
    const desktop = desktopBridge()
    const local = desktop?.pos.createReturn
    if (desktop && local) {
      const approvedBy = currentUserId()
      const lookup = desktop.pos.getReturnByOperation
      if (!lookup) throw new Error('Для безпечного повернення потрібна оновлена локальна програма')
      const data = await createLocalReturn(returnScope(), approvedBy, body, {
        getOpenShift: desktop.pos.getOpenShift, createReturn: local, getReturnByOperation: lookup,
      }, localStorage, operationId)
      requestSync()
      return { data: data as CustomerReturn }
    }
    if (desktop) throw new Error('Локальне повернення недоступне. Оновіть програму — операцію на сервер не відправлено.')
    const headers = operationId ? { 'X-Idempotency-Key': operationId } : undefined
    return api.post<{ data: CustomerReturn }>('/api/v1/returns', body, headers)
  },
}
