import { describe, expect, it } from 'vitest'
import { payoutErrorText, payoutRows, payoutTotal } from './salaryPayoutModel'

// 23.11.2026 (власник): касир видає зарплату наприкінці дня; бракує готівки — «коштами власника».
describe('salary payout for the cashier', () => {
  it('keeps only real rows and never shows a negative amount due', () => {
    const rows = payoutRows([
      { employee_id: 'a', employee_name: 'A', role: 'cashier', earned: 100, paid: 0, penalty: 0, pending_day_rate: 0, due: 100 },
      { employee_id: 'b', employee_name: 'B', role: 'manager', earned: 0, paid: 50, penalty: 0, pending_day_rate: 0, due: -50 },
      null, 'x', { employee_name: 'no id' },
    ])
    expect(rows.map(row => [row.employee_id, row.due])).toEqual([['a', 100], ['b', 0]])
    expect(payoutTotal(rows)).toBe(100)
    expect(payoutRows(undefined)).toEqual([])
  })

  it('when the till has too little cash, says what to do', () => {
    expect(payoutErrorText('У касі недостатньо готівки для цієї виплати')).toContain('Коштами власника')
    expect(payoutErrorText('Касова зміна не відкрита')).toBe('Касова зміна не відкрита')
  })
})
