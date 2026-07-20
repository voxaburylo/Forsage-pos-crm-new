import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
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

export const returnApi = {
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

  create: async (body: CreateReturnBody) => {
    const desktop = desktopBridge()
    const local = desktop?.pos.createReturn
    if (desktop && local) {
      const approvedBy = currentUserId()
      const shift = await desktop.pos.getOpenShift(approvedBy)
      const data = await local({ ...body, approved_by: approvedBy, shift_id: shift?.id ?? null })
      requestSync()
      return { data: data as CustomerReturn }
    }
    return api.post<{ data: CustomerReturn }>('/api/v1/returns', body)
  },
}
