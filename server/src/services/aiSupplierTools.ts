import { pool } from '../db/pg.js'
import { judgeName, MESSY_NAME_RE, RUSSIAN_NAME_RE } from './aiJobService.js'

/**
 * 26.11.2026, слово власника: «і ШІ має доступ до цієї бази теж — щоб там теж можна було перекладати товар, сортувати
 * і так далі» (товари постачальників за API — Омега, GPL). Помічник у чаті читає їх сторінками й пропонує зміни
 * однією карткою «було → стане»; записує лише власник/адміністратор кнопкою. Зміни — наші поля поверх прайсу
 * (custom_name, власна категорія, «прибрано»), тож прайс постачальника їх не перезапише.
 * Увесь асортимент постачальника (десятки тисяч назв) — фоновою задачею (prepare_bulk_job), а не сторінками.
 */
export const SUPPLIER_PAGE_MAX = 200

type Connection = { id: string; name: string; provider: string }

async function connections(tenantId: string): Promise<Connection[]> {
  return (await pool.query('SELECT id, name, provider FROM supplier_api_connections WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows
}

/** Постачальник за словом із чату: «Омега», «omega», «GPL». Порожньо — усі. */
export function pickConnections(all: Connection[], wanted: unknown): Connection[] {
  const word = String(wanted ?? '').trim().toLocaleLowerCase('uk-UA')
  if (!word) return all
  const latin = word.replace('омега', 'omega').replace('джипіел', 'gpl')
  return all.filter(row => row.name.toLocaleLowerCase('uk-UA').includes(word) || row.provider.includes(latin))
}

export async function listSupplierOffersForAi(tenantId: string, args: Record<string, unknown>) {
  const chosen = pickConnections(await connections(tenantId), args?.supplier)
  if (!chosen.length) return { error: 'Постачальника за API не знайдено. Підключення — Налаштування → «API-ключі».' }
  const perPage = Math.min(Math.max(Number(args?.per_page) || SUPPLIER_PAGE_MAX, 1), SUPPLIER_PAGE_MAX)
  const page = Math.max(Number(args?.page) || 1, 1)
  const filter = String(args?.filter ?? 'all')
  const params: unknown[] = [tenantId, chosen.map(row => row.id)]
  const where = ['o.tenant_id = $1', 'o.connection_id = ANY($2)']
  if (args?.include_hidden !== true) where.push('NOT o.hidden')
  if (filter === 'messy_names') { params.push(MESSY_NAME_RE); where.push(`COALESCE(o.custom_name, o.name) ~* $${params.length}`) }
  if (filter === 'russian_names') { params.push(RUSSIAN_NAME_RE); where.push(`COALESCE(o.custom_name, o.name) ~* $${params.length}`) }
  if (filter === 'no_category') where.push('o.category_id IS NULL')
  const q = String(args?.q ?? '').trim().toLowerCase()
  if (q) {
    for (const term of q.replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5)) {
      params.push('%' + term + '%')
      where.push(`lower(COALESCE(o.custom_name, o.name) || ' ' || COALESCE(o.number, '') || ' ' || COALESCE(o.custom_barcode, o.barcode, '')) LIKE $${params.length}`)
    }
  }
  const total = Number((await pool.query(`SELECT count(*)::int AS n FROM supplier_offers o WHERE ${where.join(' AND ')}`, params)).rows[0]?.n ?? 0)
  const { rows } = await pool.query(
    `SELECT o.connection_id::text || ':' || o.external_id AS key, o.number, o.brand, COALESCE(o.custom_name, o.name) AS name, o.category_name AS supplier_category,
            c.name AS category, o.total_qty, o.hidden, sc.name AS supplier
       FROM supplier_offers o JOIN supplier_api_connections sc ON sc.id = o.connection_id LEFT JOIN categories c ON c.id = o.category_id
      WHERE ${where.join(' AND ')} ORDER BY o.total_qty DESC, o.external_id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params)
  return {
    total, page, pages: Math.ceil(total / perPage),
    hint: total > perPage * 3 ? `Товарів ${total}: для всіх одразу запропонуй власнику фонову задачу (prepare_bulk_job, target=supplier_offers).` : undefined,
    offers: rows.map((row: any) => ({ key: row.key, supplier: row.supplier, number: row.number, brand: row.brand, name: row.name,
      category: row.category, supplier_category: row.supplier_category, qty: Number(row.total_qty) || 0, hidden: Boolean(row.hidden) })),
  }
}

/** Картка «було → стане» для підтвердження. */
export async function supplierOffersPreview(tenantId: string, updates: any[]) {
  const keys = updates.map(update => String(update?.key ?? '')).filter(Boolean)
  const { rows } = await pool.query(
    `SELECT o.connection_id::text || ':' || o.external_id AS key, o.number, COALESCE(o.custom_name, o.name) AS name, c.name AS category
       FROM supplier_offers o LEFT JOIN categories c ON c.id = o.category_id
      WHERE o.tenant_id = $1 AND o.connection_id::text || ':' || o.external_id = ANY($2)`, [tenantId, keys])
  const current = new Map(rows.map((row: any) => [row.key, row]))
  return updates.map(update => {
    const row: any = current.get(String(update?.key ?? ''))
    return {
      'Артикул': row?.number ?? '?', 'Було': row?.name ?? '(не знайдено)',
      'Стане': typeof update?.new_name === 'string' && update.new_name.trim() ? update.new_name.trim() : row?.name ?? '—',
      'Категорія': typeof update?.category_name === 'string' && update.category_name.trim() ? update.category_name.trim() : row?.category ?? '—',
      'Сайт': update?.hidden === true ? 'прибрати' : update?.hidden === false ? 'повернути' : '—',
    }
  })
}

/**
 * Запис підтвердженої пачки. Кожна нова назва проходить ту саму перевірку, що й у фоновій задачі: вигадане число
 * чи загублений артикул — рядок пропускається з причиною. Категорія — лише наявна (нову створюють у «Категоріях»).
 */
export async function applySupplierOfferUpdates(tenantId: string, updates: any[]): Promise<{ updated: number; failed: number; errors: Array<{ item: string; error: string }> }> {
  const list = updates.slice(0, 500)
  const keys = list.map(update => String(update?.key ?? ''))
  const { rows } = await pool.query(
    `SELECT o.connection_id::text || ':' || o.external_id AS key, o.number, COALESCE(o.custom_name, o.name) AS name
       FROM supplier_offers o WHERE o.tenant_id = $1 AND o.connection_id::text || ':' || o.external_id = ANY($2)`, [tenantId, keys])
  const current = new Map(rows.map((row: any) => [row.key, row]))
  const categories = new Map((await pool.query('SELECT id, name FROM categories WHERE tenant_id = $1', [tenantId])).rows
    .map((row: any) => [String(row.name).trim().toLocaleLowerCase('uk-UA'), row.id]))
  const errors: Array<{ item: string; error: string }> = []
  let updated = 0
  for (const update of list) {
    const row: any = current.get(String(update?.key ?? ''))
    if (!row) { errors.push({ item: String(update?.new_name ?? update?.key ?? '?'), error: 'Товар постачальника не знайдено (прайс оновився?)' }); continue }
    const sets: string[] = [], params: unknown[] = [tenantId, row.key]
    if (typeof update.new_name === 'string' && update.new_name.trim()) {
      const verdict = judgeName('cleanup', row.name, row.number, update.new_name, '')
      if (verdict.state === 'suspicious') { errors.push({ item: row.name, error: 'Назва не пройшла перевірку: ' + verdict.note }); continue }
      if (verdict.state === 'proposed') { params.push(verdict.name); sets.push(`custom_name = $${params.length}`) }
    }
    if (typeof update.category_name === 'string' && update.category_name.trim()) {
      const id = categories.get(update.category_name.trim().toLocaleLowerCase('uk-UA'))
      if (!id) { errors.push({ item: row.name, error: `Категорії «${update.category_name.trim()}» немає. Створіть її в «Категоріях».` }); continue }
      params.push(id); sets.push(`category_id = $${params.length}`, "category_source = 'manual'")
    }
    if (typeof update.hidden === 'boolean') { params.push(update.hidden); sets.push(`hidden = $${params.length}`) }
    if (!sets.length) continue
    await pool.query(`UPDATE supplier_offers SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND connection_id::text || ':' || external_id = $2`, params)
    updated += 1
  }
  return { updated, failed: errors.length, errors }
}
