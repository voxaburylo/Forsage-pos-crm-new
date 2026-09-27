import { warehouseApi } from './warehouseApi'
import type { WriteoffReason } from '@/types/writeoff'
import { desktopBridge } from '@/lib/desktopBridge'

export const writeoffApi = {
  checkOperation: (id: string) => {
    const lookup = desktopBridge()?.warehouse?.getWriteoffByOperation
    if (!lookup) return Promise.reject(new Error('Для перевірки списання потрібна оновлена локальна програма'))
    return lookup(id)
  },
  list: (filters: { reason?: WriteoffReason; page?: number; per_page?: number } = {}) =>
    warehouseApi.listWriteoffs(filters),

  get: (id: string) => warehouseApi.getWriteoff(id),

  create: (body: {
    operation_id?: string
    reason: WriteoffReason
    notes?: string | null
    items: Array<{ product_id: string; qty: number }>
  }) => warehouseApi.createWriteoff(body),
}
