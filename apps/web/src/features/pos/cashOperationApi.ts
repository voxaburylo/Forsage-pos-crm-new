import { api } from '@/lib/api'
import type { CashOperation, CashSummary, CashOperationType } from '@/types/cashOperation'

export const cashOperationApi = {
  create: (shiftId: string, type: CashOperationType, amount: number, note?: string) =>
    api.post<{ data: CashOperation }>('/api/v1/cash-operations', { shift_id: shiftId, type, amount, note }),

  list: (shiftId: string) =>
    api.get<{ data: CashOperation[] }>('/api/v1/cash-operations?shift_id=' + shiftId),

  summary: (shiftId: string) =>
    api.get<{ data: CashSummary }>('/api/v1/cash-operations/summary?shift_id=' + shiftId),
}
