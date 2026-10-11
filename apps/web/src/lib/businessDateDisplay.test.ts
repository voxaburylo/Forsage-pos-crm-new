import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBusinessDate, formatBusinessDateTime } from './businessDate'

const timestampCases = [
  ['2026-09-30T20:59:59.000Z', '30.09.2026', '30.09.2026, 23:59:59'],
  ['2026-09-30T21:00:00.000Z', '01.10.2026', '01.10.2026, 00:00:00'],
  ['2026-12-31T21:59:59.000Z', '31.12.2026', '31.12.2026, 23:59:59'],
  ['2026-12-31T22:00:00.000Z', '01.01.2027', '01.01.2027, 00:00:00'],
  ['2026-10-01T00:00:00+03:00', '01.10.2026', '01.10.2026, 00:00:00'],
  ['', 'Invalid Date', 'Invalid Date'],
  ['not-a-timestamp', 'Invalid Date', 'Invalid Date'],
] as const

describe.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('salary timestamp display on a %s PC', timezone => {
  beforeEach(() => { vi.stubEnv('TZ', timezone) })
  afterEach(() => { vi.unstubAllEnvs() })

  it.each(timestampCases)('shows %s in Kyiv without changing date/date-time style', (timestamp, date, dateTime) => {
    expect(formatBusinessDate(timestamp)).toBe(date)
    expect(formatBusinessDateTime(timestamp)).toBe(dateTime)
  })
})
