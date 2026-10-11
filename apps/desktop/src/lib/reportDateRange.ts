import { validSoldDateRange } from './soldItems'

/** Report bounds are instants, never locale-dependent dates or sortable text. */
export function normalizeReportDateRange(from: unknown, to: unknown): { from: string; to: string } {
  const valid = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    return !!match && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60
      && validSoldDateRange(match[1], match[1]) && Number.isFinite(Date.parse(value))
  }
  if (!valid(from) || !valid(to) || Date.parse(from) > Date.parse(to)) throw new Error('Некоректний період звіту')
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}
