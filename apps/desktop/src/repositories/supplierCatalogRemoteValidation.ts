import { isDeepStrictEqual } from 'node:util'

type Row = Record<string, any>
export function invalidCatalogCopy(): Error {
  return new Error('Некоректна або суперечлива копія прайсу. Цю частину не застосовано; синхронізацію не завершено.')
}
export function validateCatalogRecord(record: any): asserts record is Row {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.id !== 'string' || !record.id.trim() || record.id !== record.id.trim() || record.id.length > 200)
    throw invalidCatalogCopy()
}
export function catalogCopyRows(value: unknown): Row[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidCatalogCopy()
  const ids = new Set<string>()
  for (const row of value) {
    validateCatalogRecord(row)
    if (ids.has(row.id)) throw invalidCatalogCopy()
    ids.add(row.id)
  }
  return value
}

// Keep fractional server timestamps: Date.parse alone loses PostgreSQL microseconds.
export function catalogVersion(value: unknown): bigint {
  if (typeof value !== 'string') throw invalidCatalogCopy()
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) throw invalidCatalogCopy()
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1
    || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
    throw invalidCatalogCopy()
  const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`)
  if (!Number.isFinite(ms)) throw invalidCatalogCopy()
  return BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, '0'))
}
export function catalogTimestamp(value: unknown): string {
  catalogVersion(value)
  return value as string
}
export function remoteCatalogIsOlder(previous: Row | undefined, updatedAt: string): boolean {
  if (!previous) return false
  const incoming = catalogVersion(updatedAt)
  return [previous.remote_updated_at, previous.updated_at].some(value => value != null && incoming < catalogVersion(value))
}
export function verifyCatalogVersionContent(previous: Row | undefined, expected: Row, explicitVersion: boolean): void {
  if (!previous) return
  // A legacy copy without a version can enrich missing scope, not replace
  // already-known business data merely because it was downloaded later.
  if (explicitVersion && (previous.remote_updated_at == null
    || catalogVersion(previous.remote_updated_at) !== catalogVersion(expected.remote_updated_at))) return
  // Older servers omitted scope metadata. Enrich that metadata only; do not
  // accept two different quantities/prices/history contents for one version.
  const ignored = new Set(['remote_updated_at', 'updated_at', 'created_at'])
  if (previous.scope_known === 0 && expected.scope_known === 1) {
    ignored.add('mode'); ignored.add('warehouse_name'); ignored.add('scope_known')
  }
  for (const key of Object.keys(expected)) {
    if (ignored.has(key)) continue
    let left = expected[key], right = previous[key]
    if (key === 'errors_json') {
      try { left = JSON.parse(left); right = JSON.parse(right) } catch { throw invalidCatalogCopy() }
    }
    if (!isDeepStrictEqual(left, right)) throw invalidCatalogCopy()
  }
}
export function catalogHistoryCount(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)))
    throw invalidCatalogCopy()
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647) throw invalidCatalogCopy()
  return count
}
export function catalogHistoryErrors(value: unknown): string {
  if (!Array.isArray(value) || value.some(error => !error || typeof error !== 'object' || Array.isArray(error)
    || !Number.isSafeInteger(error.row) || error.row < 0 || typeof error.error !== 'string'
    || (error.raw !== undefined && typeof error.raw !== 'string'))) throw invalidCatalogCopy()
  return JSON.stringify(value)
}
export function catalogCopyText(value: unknown, nullable = true): string | null {
  if (value == null && nullable) return null
  if (typeof value !== 'string' || (!nullable && !value.trim())) throw invalidCatalogCopy()
  return value
}
