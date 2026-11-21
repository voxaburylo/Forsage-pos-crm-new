import { describe, expect, it } from 'vitest'
import { shiftEndPrompt } from './shiftEndPrompt'

describe('shiftEndPrompt', () => {
  it('flags a shift opened on a previous Kyiv day', () => {
    expect(shiftEndPrompt('2026-11-20T08:00:00Z', new Date('2026-11-21T07:00:00Z'))).toBe('stale')
  })
  it('reminds in the evening of the same day', () => {
    expect(shiftEndPrompt('2026-11-21T06:00:00Z', new Date('2026-11-21T17:30:00Z'))).toBe('evening')
  })
  it('stays quiet during the working day', () => {
    expect(shiftEndPrompt('2026-11-21T06:00:00Z', new Date('2026-11-21T12:00:00Z'))).toBeNull()
  })
  it('uses the Kyiv calendar, not UTC', () => {
    // 22:30 UTC 20.11 is already 00:30 on 21.11 in Kyiv; a shift opened at 21:00 UTC (23:00 Kyiv) is yesterday's.
    expect(shiftEndPrompt('2026-11-20T21:00:00Z', new Date('2026-11-20T22:30:00Z'))).toBe('stale')
  })
  it('ignores missing or broken dates', () => {
    expect(shiftEndPrompt(null)).toBeNull()
    expect(shiftEndPrompt('not a date')).toBeNull()
  })
})
