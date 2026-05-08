import { api } from '@/lib/api'
import type { CustomerReturn, PaginatedReturns, ReturnReason, RefundMethod } from '@/types/return'

export const returnApi = {
  list: (page = 1) =>
    api.get<PaginatedReturns>(`/api/v1/returns?page=${page}&per_page=20`),

  get: (id: string) =>
    api.get<{ data: CustomerReturn }>(`/api/v1/returns/${id}`),

  create: (sale_id: string, reason: ReturnReason, refund_method: RefundMethod, reason_note?: string) =>
    api.post<{ data: CustomerReturn }>('/api/v1/returns', {
      sale_id, reason, refund_method, reason_note,
    }),
}
