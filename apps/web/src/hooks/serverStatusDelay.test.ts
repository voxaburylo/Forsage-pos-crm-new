import { expect, it } from 'vitest'
import { serverStatusDelay } from './useServerStatus'

it('re-checks quickly after a single failure and often while offline', () => {
  expect(serverStatusDelay(true, 0)).toBe(30_000)
  expect(serverStatusDelay(true, 1)).toBe(3_000)
  expect(serverStatusDelay(false, 2)).toBe(10_000)
})
