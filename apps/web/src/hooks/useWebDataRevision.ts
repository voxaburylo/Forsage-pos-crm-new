import { useEffect, useState } from 'react'

/**
 * 21.11.2026 (план швидкості вебу, «свіжі дані»). Веб показує копію з каси, але відкрита сторінка
 * сама не перечитувалась — нові чеки й залишки з'являлись лише після ручного оновлення.
 * DataFreshness помічає, що каса надіслала нові дані, і шле подію; сторінка перечитує свій список.
 */
export const WEB_DATA_UPDATED_EVENT = 'forsage:web-data-updated'

export function useWebDataRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const bump = () => setRevision(value => value + 1)
    window.addEventListener(WEB_DATA_UPDATED_EVENT, bump)
    return () => window.removeEventListener(WEB_DATA_UPDATED_EVENT, bump)
  }, [])
  return revision
}

/** Чи вважати зміну «станом на» новими даними (перше значення після відкриття — ще ні). */
export function freshnessAdvanced(previous: string | null | undefined, next: string | null): boolean {
  if (previous === undefined || !next) return false
  if (!previous) return true
  return Date.parse(next) > Date.parse(previous)
}
