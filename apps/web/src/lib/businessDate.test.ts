import { describe, expect, it } from 'vitest'
import { businessDateKey, businessDateRangeUtc } from './businessDate'

describe('desktop analytics business dates', () => {
  it('filters a winter Kyiv day without scanning adjacent UTC sales', () => {
    expect(businessDateRangeUtc('2026-01-15', '2026-01-15')).toEqual({
      from: '2026-01-14T22:00:00.000Z',
      to: '2026-01-15T21:59:59.999Z',
    })
  })

  it('filters a summer Kyiv day without scanning adjacent UTC sales', () => {
    expect(businessDateRangeUtc('2026-07-31', '2026-07-31')).toEqual({
      from: '2026-07-30T21:00:00.000Z',
      to: '2026-07-31T20:59:59.999Z',
    })
  })

  it('assigns an ISO timestamp to the Kyiv business day', () => {
    expect(businessDateKey('2026-07-30T20:59:59.999Z')).toBe('2026-07-30')
    expect(businessDateKey('2026-07-30T21:00:00.000Z')).toBe('2026-07-31')
  })
})
