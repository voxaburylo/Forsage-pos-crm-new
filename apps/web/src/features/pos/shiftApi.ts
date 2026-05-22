import { api } from '@/lib/api'
import type { Shift, ShiftReport } from '@/types/shift'

export interface ExpectedCash {
  opening_cash: number
  cash_sales: number
  cash_returns: number
  cash_in: number
  cash_out: number
  expected_amount: number
}

export const shiftApi = {
  current: () =>
    api.get<{ data: Shift | null }>('/api/v1/shifts/current'),

  open: (opening_cash: number, notes?: string) =>
    api.post<{ data: Shift }>('/api/v1/shifts/open', { opening_cash, notes }),

  close: (shiftId: string, closing_cash: number, notes?: string) =>
    api.post<{ data: Shift }>(`/api/v1/shifts/${shiftId}/close`, { closing_cash, notes }),

  get: (shiftId: string) =>
    api.get<{ data: Shift }>(`/api/v1/shifts/${shiftId}`),

  report: (shiftId: string) =>
    api.get<{ data: ShiftReport }>(`/api/v1/shifts/${shiftId}/report`),

  expectedCash: () =>
    api.get<{ data: ExpectedCash }>('/api/v1/shifts/current/expected-cash'),
}
