import { describe, expect, it } from 'vitest'
import { freshnessAgeMinutes, freshnessLabel } from './DataFreshness'

describe('web copy freshness', () => {
  const now = Date.parse('2026-11-16T21:00:00Z')
  it('counts whole minutes since the till last sent data', () => {
    expect(freshnessAgeMinutes('2026-11-16T20:45:30Z', now)).toBe(14)
    expect(freshnessAgeMinutes('2026-11-16T21:05:00Z', now)).toBe(0)
  })
  it('says plainly when nothing has arrived or the value is broken', () => {
    expect(freshnessAgeMinutes(null, now)).toBeNull()
    expect(freshnessAgeMinutes('not a date', now)).toBeNull()
    expect(freshnessLabel(null, now)).toBe('Дані з каси ще не надходили')
  })
  it('shows the date and time of the copy', () => {
    expect(freshnessLabel('2026-11-16T20:45:00Z', now)).toMatch(/^Дані станом на \d{2}\.\d{2}, \d{2}:\d{2}$/)
  })
})
