import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

// Локальне читання даних для офлайн-режиму. Формат відповідей навмисне збігається
// з серверними роутами (`{ data, pagination }`, ті самі поля), щоб фронт не
// відрізняв локальну відповідь від серверної.

interface ListParams {
  search?: string
  page?: number
  per_page?: number
  sort?: string
  has_debt?: string
  status?: string
  [key: string]: string | number | undefined
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

// Локальні колонки клієнта → формат серверного Customer.
function mapCustomer(row: any): any {
  if (!row) return row
  const { tags_json, remote_updated_at, dirty_at, search_text, ...rest } = row
  return { ...rest, tags: parseTags(tags_json) }
}

function mapSale(row: any): any {
  if (!row) return row
  const { remote_updated_at, dirty_at, ...rest } = row
  return {
    ...rest,
    is_debt: !!row.is_debt,
    is_fiscal: !!row.is_fiscal,
  }
}

export class LocalReadRepository {
  constructor(private readonly db: LocalDatabase) {}

  private get tenantId(): string { return DEFAULT_TENANT_ID }

  // ───────────────────────── Клієнти ─────────────────────────
  listCustomers(params: ListParams = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const page = toInt(params.page, 1)
    const perPage = toInt(params.per_page, 50)
    const offset = (page - 1) * perPage
    const where: string[] = ['tenant_id = ?', 'deleted_at IS NULL']
    const args: any[] = [this.tenantId]

    const search = (params.search ?? '').trim()
    if (search) {
      where.push('(phone LIKE ? OR full_name LIKE ? OR card_barcode LIKE ?)')
      const like = `%${search}%`
      args.push(like, like, like)
    }
    if (params.has_debt === 'true') where.push('debt_balance > 0')
    if (params.has_debt === 'false') where.push('debt_balance = 0')

    const whereSql = where.join(' AND ')
    const order = params.sort === 'recent' ? 'updated_at DESC'
      : params.sort === 'debt' ? 'debt_balance DESC'
      : 'full_name COLLATE NOCASE ASC'

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${whereSql}`).get(...args) as { n: number }).n
    const rows = this.db.prepare(
      `SELECT * FROM customers WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...args, perPage, offset) as any[]

    const vinStmt = this.db.prepare(
      "SELECT vin FROM customer_vehicles WHERE customer_id = ? AND deleted_at IS NULL AND vin IS NOT NULL AND vin <> '' LIMIT 1",
    )
    const countStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM customer_vehicles WHERE customer_id = ? AND deleted_at IS NULL',
    )
    const data = rows.map((r) => ({
      ...mapCustomer(r),
      primary_vin: (vinStmt.get(r.id) as { vin: string } | undefined)?.vin ?? null,
      car_count: (countStmt.get(r.id) as { n: number }).n,
    }))

    return { data, pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) } }
  }

  getCustomer(id: string): { data: any } | null {
    const row = this.db.prepare(
      'SELECT * FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    ).get(id, this.tenantId) as any
    if (!row) return null
    return { data: mapCustomer(row) }
  }

  // ───────────────────────── Чеки (продажі) ─────────────────────────
  listSales(params: ListParams = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const page = toInt(params.page, 1)
    const perPage = toInt(params.per_page, 20)
    const offset = (page - 1) * perPage
    const where: string[] = ['s.tenant_id = ?', 's.deleted_at IS NULL']
    const args: any[] = [this.tenantId]

    if (params.status) { where.push('s.status = ?'); args.push(String(params.status)) }

    const search = (params.search ?? '').trim()
    if (search) {
      where.push('(s.sale_number LIKE ? OR c.phone LIKE ? OR c.full_name LIKE ?)')
      const like = `%${search}%`
      args.push(like, like, like)
    }

    const whereSql = where.join(' AND ')
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE ${whereSql}`,
    ).get(...args) as { n: number }).n

    const rows = this.db.prepare(`
      SELECT s.*, c.id AS c_id, c.phone AS c_phone, c.full_name AS c_full_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE ${whereSql}
      ORDER BY COALESCE(s.completed_at, s.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...args, perPage, offset) as any[]

    const itemsCountStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ? AND deleted_at IS NULL',
    )
    const data = rows.map((r) => {
      const { c_id, c_phone, c_full_name, ...sale } = r
      const n = (itemsCountStmt.get(r.id) as { n: number }).n
      return {
        ...mapSale(sale),
        customer: c_id ? { id: c_id, phone: c_phone, full_name: c_full_name } : null,
        sale_items: Array.from({ length: n }, () => ({ id: '' })),
      }
    })

    return { data, pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) } }
  }

  // ───────────────────────── Постачальники ─────────────────────────
  listSuppliers(params: ListParams = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const page = toInt(params.page, 1)
    const perPage = toInt(params.per_page, 50)
    const offset = (page - 1) * perPage
    const where: string[] = ['tenant_id = ?', 'deleted_at IS NULL']
    const args: any[] = [this.tenantId]

    const search = (params.search ?? '').trim()
    if (search) {
      where.push('(name LIKE ? OR phone LIKE ? OR contact_name LIKE ?)')
      const like = `%${search}%`
      args.push(like, like, like)
    }
    const whereSql = where.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM suppliers WHERE ${whereSql}`).get(...args) as { n: number }).n
    const rows = this.db.prepare(
      `SELECT * FROM suppliers WHERE ${whereSql} ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
    ).all(...args, perPage, offset) as any[]
    const data = rows.map((r) => { const { remote_updated_at, dirty_at, ...rest } = r; return { ...rest, is_active: !!r.is_active } })
    return { data, pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) || 1 } }
  }

  getSupplier(id: string): { data: any } | null {
    const row = this.db.prepare(
      'SELECT * FROM suppliers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    ).get(id, this.tenantId) as any
    if (!row) return null
    const { remote_updated_at, dirty_at, ...rest } = row
    return { data: { ...rest, is_active: !!row.is_active } }
  }

  // ───────────────────────── Товари ─────────────────────────
  listProducts(params: ListParams = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const page = toInt(params.page, 1)
    const perPage = toInt(params.per_page, 50)
    const offset = (page - 1) * perPage
    const where: string[] = ['p.tenant_id = ?', 'p.deleted_at IS NULL']
    const args: any[] = [this.tenantId]

    const search = (params.search ?? '').toString().replace(/^oem:/, '').trim()
    if (search) {
      where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.barcode LIKE ?)')
      const like = `%${search}%`
      args.push(like, like, like)
    }
    if (params.category_id) { where.push('p.category_id = ?'); args.push(String(params.category_id)) }
    if (params.brand_id) { where.push('p.brand_id = ?'); args.push(String(params.brand_id)) }
    if (params.is_active !== undefined) { where.push('p.is_active = ?'); args.push(params.is_active === 'true' ? 1 : 0) }
    if (params.low_stock === 'true') where.push('p.qty_on_hand <= p.reorder_point')

    const whereSql = where.join(' AND ')
    const sortField = ({ sku: 'p.sku', name: 'p.name', retail_price: 'p.retail_price', qty_on_hand: 'p.qty_on_hand', created_at: 'p.created_at' } as Record<string, string>)[String(params.sort_field ?? '')] ?? 'p.name'
    const sortDir = String(params.sort_dir) === 'desc' ? 'DESC' : 'ASC'

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${whereSql}`).get(...args) as { n: number }).n
    const rows = this.db.prepare(`
      SELECT p.*, b.name AS b_name, cat.name AS cat_name
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE ${whereSql}
      ORDER BY ${sortField} COLLATE NOCASE ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...args, perPage, offset) as any[]

    return { data: rows.map((r) => this.mapProduct(r)), pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) || 1 } }
  }

  getProduct(id: string): { data: any } | null {
    const row = this.db.prepare(`
      SELECT p.*, b.name AS b_name, cat.name AS cat_name
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL
    `).get(id, this.tenantId) as any
    if (!row) return null
    return { data: this.mapProduct(row) }
  }

  private mapProduct(r: any): any {
    const { b_name, cat_name, specs_json, search_text, dirty_at, remote_updated_at, ...rest } = r
    let specs: any = {}
    try { specs = specs_json ? JSON.parse(specs_json) : {} } catch { specs = {} }
    const qtyOnHand = Number(r.qty_on_hand ?? 0)
    return {
      ...rest,
      is_active: !!r.is_active,
      is_service: !!r.is_service,
      is_favorite: !!r.is_favorite,
      specs,
      brand: r.brand_id ? { id: r.brand_id, name: b_name } : null,
      category: r.category_id ? { id: r.category_id, name: cat_name } : null,
      qty_reserved: 0,
      qty_available: qtyOnHand,
    }
  }

  getSale(id: string): { data: any } | null {
    const row = this.db.prepare(
      'SELECT * FROM sales WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    ).get(id, this.tenantId) as any
    if (!row) return null
    const customer = row.customer_id
      ? this.db.prepare('SELECT id, phone, full_name FROM customers WHERE id = ?').get(row.customer_id)
      : null
    const items = this.db.prepare(
      'SELECT * FROM sale_items WHERE sale_id = ? AND deleted_at IS NULL',
    ).all(id) as any[]
    return { data: { ...mapSale(row), customer, sale_items: items } }
  }
}
