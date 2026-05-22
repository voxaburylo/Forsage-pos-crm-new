import { api } from '@/lib/api'
import type { Writeoff, PaginatedWriteoffs, WriteoffReason } from '@/types/writeoff'

function buildQuery(p: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  Object.entries(p).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? '?' + params.toString() : ''
}

export const writeoffApi = {
  list: (filters: { reason?: WriteoffReason; page?: number; per_page?: number } = {}) =>
    api.get<PaginatedWriteoffs>('/api/v1/writeoffs' + buildQuery(filters as Record<string, string | number | undefined>)),

  get: (id: string) =>
    api.get<{ data: Writeoff }>('/api/v1/writeoffs/' + id),

  create: (body: {
    reason: WriteoffReason
    notes?: string | null
    items: Array<{ product_id: string; qty: number }>
  }) =>
    api.post<{ data: Writeoff }>('/api/v1/writeoffs', body),
}
