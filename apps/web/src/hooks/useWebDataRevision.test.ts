import { expect, it } from 'vitest'
import { freshnessAdvanced } from './useWebDataRevision'

it('signals new till data only when the timestamp moves forward', () => {
  expect(freshnessAdvanced(undefined, '2026-11-21T10:00:00Z')).toBe(false)
  expect(freshnessAdvanced('2026-11-21T10:00:00Z', '2026-11-21T10:00:00Z')).toBe(false)
  expect(freshnessAdvanced('2026-11-21T10:00:00Z', '2026-11-21T10:01:00Z')).toBe(true)
  expect(freshnessAdvanced(null, '2026-11-21T10:01:00Z')).toBe(true)
  expect(freshnessAdvanced('2026-11-21T10:01:00Z', null)).toBe(false)
})
