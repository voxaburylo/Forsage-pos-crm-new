import { expect, it } from 'vitest'
import { yesterdayKey } from './MorningBrief'

it('takes yesterday by the Kyiv calendar', () => {
  // 21.11 00:30 Kyiv = 20.11 22:30 UTC → yesterday is 20.11 in Kyiv.
  expect(yesterdayKey(new Date('2026-11-20T22:30:00Z'))).toBe('2026-11-20')
  expect(yesterdayKey(new Date('2026-11-21T12:00:00Z'))).toBe('2026-11-20')
})
