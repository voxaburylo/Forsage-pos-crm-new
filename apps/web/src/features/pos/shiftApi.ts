import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import type { Shift, ShiftReport } from '@/types/shift'

type ShiftRequestOptions = {
  silent?: boolean
  timeoutMs?: number
}

const SHIFT_READ_TIMEOUT_MS = 10_000
const SHIFT_WRITE_TIMEOUT_MS = 15_000
const SHIFT_CLOSE_TIMEOUT_MS = 20_000

export interface ExpectedCash {
  opening_cash: number
  cash_sales: number
  cash_returns: number
  cash_in: number
  cash_out: number
  expected_amount: number
}

function cashierId(): string {
  return useAuthStore.getState().session?.user?.id ?? ''
}

export const shiftApi = {
  current: async (options?: ShiftRequestOptions) => {
    const local = desktopBridge()?.pos
    if (local) return { data: await local.getOpenShift(cashierId()) }
    return api.get<{ data: Shift | null }>('/api/v1/shifts/current', {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    })
  },

  open: async (opening_cash: number, notes?: string, options?: ShiftRequestOptions) => {
    const local = desktopBridge()?.pos
    if (local) {
      const id = await local.openShift({ cashier_id: cashierId(), opening_cash, notes })
      return { data: await local.getOpenShift(cashierId()) ?? ({ id, cashier_id: cashierId(), status: 'open', opening_cash } as Shift) }
    }
    return api.post<{ data: Shift }>(
      '/api/v1/shifts/open',
      { opening_cash, notes },
      undefined,
      { timeoutMs: SHIFT_WRITE_TIMEOUT_MS, ...options },
    )
  },

  close: async (shiftId: string, closing_cash: number, notes?: string, options?: ShiftRequestOptions) => {
    const local = desktopBridge()?.pos
    if (local) {
      const current = await local.getOpenShift(cashierId())
      await local.closeShift(cashierId(), closing_cash, notes ?? null)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return { data: ({ ...current, id: current?.id ?? shiftId, status: 'closed', closing_cash, closed_at: new Date().toISOString() } as Shift) }
    }
    return api.post<{ data: Shift }>(
      `/api/v1/shifts/${shiftId}/close`,
      { closing_cash, notes },
      undefined,
      { timeoutMs: SHIFT_CLOSE_TIMEOUT_MS, ...options },
    )
  },

  get: async (shiftId: string, options?: ShiftRequestOptions) => {
    const local = desktopBridge()?.pos
    if (local) {
      const data = await local.getOpenShift(cashierId())
      if (!data || data.id !== shiftId) throw new Error('Зміну не знайдено')
      return { data }
    }
    return api.get<{ data: Shift }>(`/api/v1/shifts/${shiftId}`, {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    })
  },

  report: async (shiftId: string, options?: ShiftRequestOptions) => {
    const local = desktopBridge()?.pos
    if (local) {
      const data = await local.shiftReport(cashierId())
      if (!data) throw new Error('Зміну не знайдено')
      return { data }
    }
    return api.get<{ data: ShiftReport }>(`/api/v1/shifts/${shiftId}/report`, {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    })
  },

  expectedCash: async (options?: ShiftRequestOptions) => {
    const local = desktopBridge()?.pos
    if (local) {
      const data = await local.expectedCash(cashierId())
      if (!data) throw new Error('Спочатку відкрийте касову зміну')
      return { data }
    }
    return api.get<{ data: ExpectedCash }>('/api/v1/shifts/current/expected-cash', {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    })
  },
}
