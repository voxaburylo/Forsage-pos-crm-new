import type { Product } from '@/types/product'

export function normalizeAnalogs(sourceId: string, rows: Product[]): Product[] {
  return [...new Map(rows.filter(p => p.id && p.id !== sourceId).map(p => [p.id, p])).values()]
    .sort((a,b) => Number((b.qty_available ?? b.qty_on_hand) > 0) - Number((a.qty_available ?? a.qty_on_hand) > 0)
      || a.name.localeCompare(b.name, 'uk'))
}

// Only one background lookup at a time; cancelled/offscreen work is skipped.
let tail: Promise<unknown> = Promise.resolve()
export function queueAnalogLookup<T>(active: () => boolean, load: () => Promise<T>): Promise<T | undefined> {
  const task = tail.then(() => active() ? load() : undefined)
  tail = task.catch(() => {})
  return task
}
