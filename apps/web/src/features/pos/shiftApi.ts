import { api } from '@/lib/api'
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

export const shiftApi = {
  current: (options?: ShiftRequestOptions) =>
    api.get<{ data: Shift | null }>('/api/v1/shifts/current', {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    }),

  open: (opening_cash: number, notes?: string, options?: ShiftRequestOptions) =>
    api.post<{ data: Shift }>(
      '/api/v1/shifts/open',
      { opening_cash, notes },
      undefined,
      { timeoutMs: SHIFT_WRITE_TIMEOUT_MS, ...options },
    ),

  close: (shiftId: string, closing_cash: number, notes?: string, options?: ShiftRequestOptions) =>
    api.post<{ data: Shift }>(
      `/api/v1/shifts/${shiftId}/close`,
      { closing_cash, notes },
      undefined,
      { timeoutMs: SHIFT_CLOSE_TIMEOUT_MS, ...options },
    ),

  get: (shiftId: string, options?: ShiftRequestOptions) =>
    api.get<{ data: Shift }>(`/api/v1/shifts/${shiftId}`, {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    }),

  report: (shiftId: string, options?: ShiftRequestOptions) =>
    api.get<{ data: ShiftReport }>(`/api/v1/shifts/${shiftId}/report`, {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    }),

  expectedCash: (options?: ShiftRequestOptions) =>
    api.get<{ data: ExpectedCash }>('/api/v1/shifts/current/expected-cash', {
      timeoutMs: SHIFT_READ_TIMEOUT_MS,
      ...options,
    }),
}
