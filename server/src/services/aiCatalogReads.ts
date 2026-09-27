import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { AI_TIME_LIMITS, AiExecutionBudget, withAiExecutionBudget } from './aiExecutionBudget.js'

type ReadDb = Pick<SupabaseClient, 'from'>
type Row = { id: string; [key: string]: any }
export const AI_CATALOG_LIMITS = { products: 50_000, lookups: 2_000, pages: 250, pageSize: 500, scanBytes: 32 * 1024 * 1024, responseBytes: 128 * 1024 } as const

function limitError(): AppError {
  return new AppError('AI_READ_LIMIT', 'Каталог завеликий для одного запиту ШІ. Перевіряйте його частинами. Неповний результат не застосовано.', 422)
}

export function boundedAiReadResult<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > AI_CATALOG_LIMITS.responseBytes) throw limitError()
  return value
}

/** Explicit tenant/deletion scope, stable ID cursor; never present a truncated scan as complete. */
async function readAll(
  db: ReadDb, tenantId: string, table: 'products' | 'categories' | 'brands',
  columns: string, maxRows: number, budget: AiExecutionBudget,
): Promise<Row[]> {
  const rows: Row[] = []
  let after = ''
  let bytes = 0
  for (let page = 0; page < AI_CATALOG_LIMITS.pages; page++) {
    budget.check()
    let query = db.from(table).select(columns).eq('tenant_id', tenantId).is('deleted_at', null)
      .order('id', { ascending: true }).limit(Math.min(AI_CATALOG_LIMITS.pageSize, maxRows - rows.length + 1))
    if (after) query = query.gt('id', after)
    const { data, error } = await budget.run(signal => query.abortSignal(signal))
    if (error || !Array.isArray(data)) throw new AppError('AI_READ_FAILED', 'Не вдалося прочитати каталог. Повторіть запит.', 503)
    // Continue to an empty page even when the project has a lower PostgREST row cap.
    if (data.length === 0) return rows
    if (rows.length + data.length > maxRows) throw limitError()
    bytes += Buffer.byteLength(JSON.stringify(data), 'utf8')
    if (bytes > AI_CATALOG_LIMITS.scanBytes) throw limitError()
    for (const value of data as unknown as Row[]) {
      if (typeof value.id !== 'string' || value.id <= after) {
        throw new AppError('AI_READ_FAILED', 'Каталог змінився або повернув некоректну сторінку. Повторіть запит.', 503)
      }
      after = value.id
      rows.push(value)
    }
  }
  throw limitError()
}

export async function readAiLookup(db: ReadDb, tenantId: string, table: 'categories' | 'brands', parent: AiExecutionBudget) {
  return withAiExecutionBudget(AI_TIME_LIMITS.read, async budget => {
    const rows = await readAll(db, tenantId, table, 'id, name', AI_CATALOG_LIMITS.lookups, budget)
    return boundedAiReadResult({ [table]: rows.map(row => ({ id: row.id, name: row.name })) })
  }, parent.signal)
}

export async function readAiDuplicates(
  db: ReadDb, tenantId: string, by: 'name' | 'sku', limit: number, parent: AiExecutionBudget,
) {
  return withAiExecutionBudget(AI_TIME_LIMITS.read, async budget => {
    const rows = await readAll(db, tenantId, 'products', 'id, sku, name, qty_on_hand, retail_price', AI_CATALOG_LIMITS.products, budget)
    const groups = new Map<string, Row[]>()
    for (const row of rows) {
      budget.check()
      const key = by === 'sku' ? normalizeArticle(String(row.sku ?? '')) : String(row.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      if (!key) continue
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }
    const duplicates = [...groups.values()].filter(group => group.length >= 2).sort((a, b) => b.length - a.length)
    const result = boundedAiReadResult({
      total_groups: duplicates.length,
      showing: Math.min(limit, duplicates.length),
      groups: duplicates.slice(0, limit).map(group => ({
        products: group.map(row => ({
          product_id: row.id, sku: row.sku, name: row.name,
          qty: row.qty_on_hand, price_uah: (row.retail_price ?? 0) / 100,
        })),
      })),
    })
    budget.check()
    return result
  }, parent.signal)
}
