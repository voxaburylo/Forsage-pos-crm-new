import { useEffect, useState } from 'react'
import { businessDateKey, businessDateRangeUtc } from '@/lib/businessDate'

type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
type DayEnvironment = { window: EventSource; document: EventSource & { visibilityState: string } }

/** Observe the shop day only; no API polling and no form/action state resets. */
export function observeBusinessDay(onChange: (day: string) => void,
  environment: DayEnvironment = { window, document }): () => void {
  let stopped = false
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    const now = new Date()
    const day = businessDateKey(now)
    if (day !== previous) { previous = day; onChange(day) }
    // The next Kyiv midnight is not always 24 hours away (DST). The bounded
    // recheck also notices a changed system clock while the window stays open.
    const midnight = Date.parse(businessDateRangeUtc(day, day).to) + 1
    timer = setTimeout(check, Math.max(1, Math.min(60_000, midnight - now.getTime())))
  }
  const visible = () => { if (environment.document.visibilityState !== 'hidden') check() }
  environment.window.addEventListener('focus', check)
  environment.document.addEventListener('visibilitychange', visible)
  check()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    environment.window.removeEventListener('focus', check)
    environment.document.removeEventListener('visibilitychange', visible)
  }
}

export function useBusinessDay(): string {
  const [day, setDay] = useState(businessDateKey)
  useEffect(() => observeBusinessDay(setDay), [])
  return day
}
