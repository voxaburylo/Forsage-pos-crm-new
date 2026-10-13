import { describe, expect, it } from 'vitest'
import { payrollTireHref, tireLinkContext, validReportMonth } from './reportViewContext'

describe('payroll and daily tire report navigation context', () => {
  it('preserves a payroll month without inventing a work day', () => {
    const url = payrollTireHref('worker A', '2026-09')
    expect(url).toBe('/analytics/sales?tab=tire&employee=worker+A&period=2026-09')
    expect(tireLinkContext(new URLSearchParams(url.split('?')[1]), '2026-10-13'))
      .toEqual({ date: '', period: '2026-09', employee: 'worker A' })
  })
  it('opens an operation by work date, not creation/payment date', () => {
    const url = payrollTireHref('worker', '2026-10', '2026-09-30')
    expect(tireLinkContext(new URLSearchParams(url.split('?')[1]), '2026-10-13'))
      .toEqual({ date: '2026-09-30', period: '', employee: 'worker' })
  })
  it.each(['2026-02-30', '2026-10-14', 'tomorrow', ''])('does not invent a day for invalid operation date %s', date => {
    const context = tireLinkContext(new URLSearchParams('period=2026-09&date=' + date), '2026-10-13')
    expect(context.date).toBe('')
    expect(context.period).toBe('2026-09')
  })
  it('ordinary tire entry retains the current-day default', () => {
    expect(tireLinkContext(new URLSearchParams(), '2026-10-13').date).toBe('2026-10-13')
  })
  it.each(['2026-13','0000-01','2026-1','arbitrary'])('rejects invalid month %s', value => {
    expect(validReportMonth(value)).toBe(false)
  })
})
