import { describe, expect, it } from 'vitest'
import { staleShifts } from './ShiftReminder'

describe('shift not closed reminder', () => {
  it('lists only shifts opened before today (Kyiv) with the number of days', () => {
    const now = new Date('2026-11-19T07:00:00Z')
    const rows = staleShifts([
      { id: 'a', cashier_name: 'Власник', opened_at: '2026-11-16T05:59:25Z' },
      { id: 'b', cashier_name: 'Никита', opened_at: '2026-11-19T06:00:00Z' },
      { id: 'c', cashier_name: null, opened_at: '2026-11-18T21:30:00Z' },
    ], now)
    expect(rows.map(row => [row.id, row.days])).toEqual([['a', 3], ['c', 1]])
  })
})
