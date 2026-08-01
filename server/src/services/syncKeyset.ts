import { AppError } from '../middleware/errorHandler.js'

const DEFAULT_PAGE_SIZE = 1000

export type TimestampKeysetOptions = {
  timestampColumn: string
  upperBound: string
  lowerBound?: string
  tieBreaker?: string
  pageSize?: number
  rowTimestamp?: (row: any) => unknown
  rowTieBreaker?: (row: any) => unknown
}

export function buildTimestampKeysetFilter(
  timestampColumn: string,
  timestamp: string,
  tieBreaker: string,
  tieBreakerValue: string,
): string {
  return `${timestampColumn}.gt.${timestamp},and(${timestampColumn}.eq.${timestamp},${tieBreaker}.gt.${tieBreakerValue})`
}

/**
 * Reads one timestamp-bounded database snapshot without OFFSET.  Rows written
 * after upperBound are deliberately left for the next pull.  The pair
 * (timestamp, id) is stable even when another row changes while pages are read.
 */
export async function fetchAllByTimestamp(
  buildQuery: () => any,
  options: TimestampKeysetOptions,
): Promise<any[]> {
  const rows: any[] = []
  const tieBreaker = options.tieBreaker ?? 'id'
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  let lastTimestamp: string | null = null
  let lastTieBreaker: string | null = null

  while (true) {
    let query = buildQuery()
      .lte(options.timestampColumn, options.upperBound)

    if (options.lowerBound) query = query.gt(options.timestampColumn, options.lowerBound)
    if (lastTimestamp && lastTieBreaker) {
      query = query.or(buildTimestampKeysetFilter(
        options.timestampColumn,
        lastTimestamp,
        tieBreaker,
        lastTieBreaker,
      ))
    }

    const { data, error } = await query
      .order(options.timestampColumn, { ascending: true })
      .order(tieBreaker, { ascending: true })
      .limit(pageSize)
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows

    const last = page[page.length - 1]
    const timestampValue = options.rowTimestamp?.(last) ?? last?.[options.timestampColumn]
    const tieBreakerValue = options.rowTieBreaker?.(last) ?? last?.[tieBreaker]
    if (typeof timestampValue !== 'string' || typeof tieBreakerValue !== 'string') {
      throw new AppError('SYNC_KEYSET_INVALID', `Неможливо продовжити sync keyset ${options.timestampColumn},${tieBreaker}`, 500)
    }
    lastTimestamp = timestampValue
    lastTieBreaker = tieBreakerValue
  }
}

/** Stable keyset for immutable/snapshot rows whose identifier never changes. */
export async function fetchAllById(
  buildQuery: () => any,
  tieBreaker = 'id',
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<any[]> {
  const rows: any[] = []
  let lastTieBreaker: string | null = null

  while (true) {
    let query = buildQuery()
    if (lastTieBreaker) query = query.gt(tieBreaker, lastTieBreaker)
    const { data, error } = await query
      .order(tieBreaker, { ascending: true })
      .limit(pageSize)
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows

    const value = page[page.length - 1]?.[tieBreaker]
    if (typeof value !== 'string') {
      throw new AppError('SYNC_KEYSET_INVALID', `Неможливо продовжити sync keyset ${tieBreaker}`, 500)
    }
    lastTieBreaker = value
  }
}
