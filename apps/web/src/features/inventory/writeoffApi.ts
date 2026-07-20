import { warehouseApi } from './warehouseApi'
import type { WriteoffReason } from '@/types/writeoff'

export const writeoffApi = {
  list: (filters: { reason?: WriteoffReason; page?: number; per_page?: number } = {}) =>
    warehouseApi.listWriteoffs(filters),

  get: (id: string) => warehouseApi.getWriteoff(id),

  create: (body: {
    reason: WriteoffReason
    notes?: string | null
    items: Array<{ product_id: string; qty: number }>
  }) => warehouseApi.createWriteoff(body),
}