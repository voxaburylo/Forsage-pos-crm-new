import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeBusinessDay } from './useBusinessDay'

let stop: (() => void) | undefined
const originalTimezone = process.env.TZ
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  stop?.(); stop = undefined
  vi.useRealTimers(); vi.restoreAllMocks()
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
})
function fixture(now: string) {
  vi.setSystemTime(new Date(now))
  const environment = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) }
  const changed = vi.fn()
  stop = observeBusinessDay(changed, environment)
  return { ...environment, changed }
}

describe.each(['America/Los_Angeles', 'Asia/Tokyo', 'Europe/Moscow'])('Kyiv business-day observer with PC %s', timezone => {
  it.each([
    ['2026-09-30T20:59:59.999Z', '2026-09-30', '2026-10-01'],
    ['2026-12-31T21:59:59.999Z', '2026-12-31', '2027-01-01'],
    ['2026-03-28T21:59:59.999Z', '2026-03-28', '2026-03-29'],
    ['2026-10-24T20:59:59.999Z', '2026-10-24', '2026-10-25'],
  ])('notifies exactly at Kyiv midnight starting %s', (now, before, after) => {
    process.env.TZ = timezone
    const { changed } = fixture(now)
    expect(changed.mock.calls).toEqual([[before]])
    vi.advanceTimersByTime(1)
    expect(changed.mock.calls).toEqual([[before], [after]])
    vi.advanceTimersByTime(60_000)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })
})

it.each([
  ['2026-03-28T22:00:00.000Z', 23, '2026-03-29', '2026-03-30'],
  ['2026-10-24T21:00:00.000Z', 25, '2026-10-25', '2026-10-26'],
])('handles a %s DST day with %s actual hours', (now, hours, before, after) => {
  const { changed } = fixture(now)
  vi.advanceTimersByTime(Number(hours) * 60 * 60 * 1000 - 1)
  expect(changed.mock.calls).toEqual([[before]])
  vi.advanceTimersByTime(1)
  expect(changed.mock.calls).toEqual([[before], [after]])
})

it('focus catches several sleeping days without waiting for a throttled timer', () => {
  const { window, changed } = fixture('2026-09-30T20:00:00.000Z')
  vi.setSystemTime(new Date('2026-10-03T08:00:00.000Z'))
  window.dispatchEvent(new Event('focus'))
  expect(changed.mock.calls).toEqual([['2026-09-30'], ['2026-10-03']])
  expect(vi.getTimerCount()).toBe(1)
})

it('visibility resume rechecks the current day, with no duplicate notice from focus/timers', () => {
  const { window, document, changed } = fixture('2026-12-31T21:59:59.000Z')
  document.visibilityState = 'hidden'
  vi.setSystemTime(new Date('2026-12-31T22:00:01.000Z'))
  document.dispatchEvent(new Event('visibilitychange'))
  expect(changed).toHaveBeenCalledTimes(1)
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  vi.advanceTimersByTime(60_000)
  expect(changed.mock.calls).toEqual([['2026-12-31'], ['2027-01-01']])
  expect(vi.getTimerCount()).toBe(1)
})

it('notices a corrected system clock without changing the PC timezone contract', () => {
  const { changed } = fixture('2026-10-01T09:00:00.000Z')
  vi.setSystemTime(new Date('2026-09-30T09:00:00.000Z'))
  vi.advanceTimersByTime(60_000)
  expect(changed.mock.calls).toEqual([['2026-10-01'], ['2026-09-30']])
})

it('cleans up its timer and listeners and cannot notify after unmount', () => {
  const { window, document, changed } = fixture('2026-09-30T20:59:59.000Z')
  const removeWindow = vi.spyOn(window, 'removeEventListener')
  const removeDocument = vi.spyOn(document, 'removeEventListener')
  stop!()
  expect(removeWindow).toHaveBeenCalledExactlyOnceWith('focus', expect.any(Function))
  expect(removeDocument).toHaveBeenCalledExactlyOnceWith('visibilitychange', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
  vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'))
  window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(100_000)
  expect(changed.mock.calls).toEqual([['2026-09-30']])
})

it('multiple observers can unmount independently without silencing another page', () => {
  const first = fixture('2026-09-30T20:59:59.999Z')
  const stopFirst = stop!
  const second = fixture('2026-09-30T20:59:59.999Z')
  stopFirst()
  vi.advanceTimersByTime(1)
  expect(first.changed.mock.calls).toEqual([['2026-09-30']])
  expect(second.changed.mock.calls).toEqual([['2026-09-30'], ['2026-10-01']])
  expect(vi.getTimerCount()).toBe(1)
})
