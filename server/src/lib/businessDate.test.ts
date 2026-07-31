import { describe, expect, it } from 'vitest'
import { kyivDateKey, kyivDateRange } from './businessDate.js'

describe('Kyiv business day boundaries', () => {
  it('uses the winter UTC+2 boundary', () => {
    expect(kyivDateRange('2026-01-15', '2026-01-15')).toEqual({
      from: '2026-01-14T22:00:00.000Z',
      toExclusive: '2026-01-15T22:00:00.000Z',
    })
  })

  it('uses the summer UTC+3 boundary', () => {
    expect(kyivDateRange('2026-07-31', '2026-07-31')).toEqual({
      from: '2026-07-30T21:00:00.000Z',
      toExclusive: '2026-07-31T21:00:00.000Z',
    })
  })

  it('assigns a late UTC sale to the correct Kyiv calendar day', () => {
    expect(kyivDateKey(new Date('2026-07-30T20:59:59.999Z'))).toBe('2026-07-30')
    expect(kyivDateKey(new Date('2026-07-30T21:00:00.000Z'))).toBe('2026-07-31')
  })
})
