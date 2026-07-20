import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import { useAuthStore } from '@/stores/authStore'
import type { CashOperation, CashSummary, CashOperationType } from '@/types/cashOperation'

function userId(): string | undefined {
  return useAuthStore.getState().session?.user?.id ?? undefined
}

export const cashOperationApi = {
  create: async (shiftId: string, type: CashOperationType, amount: number, note?: string, source = 'cashbox') => {
    const local = desktopBridge()?.pos.createCashOperation
    if (local) {
      const data = await local({ shift_id: shiftId, type, amount, note, source, user_id: userId() })
      requestDesktopSync()
      return { data: data as CashOperation }
    }
    return api.post<{ data: CashOperation }>('/api/v1/cash-operations', { shift_id: shiftId, type, amount, note, source })
  },

  list: async (shiftId: string) => {
    const local = desktopBridge()?.pos.listCashOperations
    if (local) return { data: await local(shiftId) as CashOperation[] }
    return api.get<{ data: CashOperation[] }>('/api/v1/cash-operations?shift_id=' + shiftId)
  },

  summary: async (shiftId: string) => {
    const local = desktopBridge()?.pos.cashOperationSummary
    if (local) return { data: await local(shiftId) as CashSummary }
    return api.get<{ data: CashSummary }>('/api/v1/cash-operations/summary?shift_id=' + shiftId)
  },
}
