import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

export type LocalSupplierMatchKind = 'barcode' | 'sku' | 'name'

export interface LocalSupplierCatalogItem {
  id: string
  tenant_id: string
  supplier_id: string | null
  sku: string
  barcode: string | null
  brand: string | null
  name: string
  price_kopecks: number
  qty: string
  warehouse_name: string | null
  matched_product_id: string | null
  match_kind: LocalSupplierMatchKind | null
  match_error: string | null
  created_at: string
  updated_at: string
  supplier?: { id: string; name: string }
}

export interface LocalSupplierCatalogItemInput {
  tenant_id?: string
  supplier_id?: string | null
  sku?: string
  barcode?: string | null
  brand?: string | null
  name: string
  price_kopecks: number
  qty?: string | number
  warehouse_name?: string | null
}

export interface LocalSupplierImportRow {
  source_row: number
  sku?: string
  barcode?: string | null
  brand?: string | null
  name: string
  qty?: string | number
  price_kopecks: number
}

export interface LocalSupplierImportOptions {
  tenant_id?: string
  supplier_id: string | null
  supplier_name?: string | null
  mode: 'replace' | 'add'
  warehouse_name?: string | null
  parse_errors?: Array<{ row: number; error: string; raw?: string }>
}

export interface LocalSupplierPriceImport {
  id: string
  tenant_id: string
  supplier_id: string | null
  filename: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  total_rows: number
  processed_rows: number
  errors_log: Array<{ row: number; error: string; raw?: string }>
  created_at: string
  updated_at: string
  suppliers?: { id: string; name: string }
}

type IdentityCandidate = {
  id: string
  sku: string
  name: string
  barcode?: string | null
  additional_barcodes?: string[]
}

type ExactMatch = {
  candidate: IdentityCandidate | null
  kind: LocalSupplierMatchKind | null
  error: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

export function normalizeLocalSupplierSku(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleUpperCase('uk-UA')
}

export function normalizeLocalSupplierBarcode(value: unknown): string {
  const compact = String(value ?? '').normalize('NFKC').trim()
    .replace(/[\s\u00a0\u202f-]/g, '')
    .replace(',', '.')
  if (/^\d+\.0+$/.test(compact)) return compact.replace(/\.0+$/, '')
  if (/^\d+(?:\.\d+)?e\+\d+$/i.test(compact)) {
    const numeric = Number(compact)
    if (Number.isSafeInteger(numeric)) return String(numeric)
  }
  return compact
}

export function normalizeLocalSupplierName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('uk-UA')
    .replace(/ё/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/ї/g, 'и')
    .replace(/і/g, 'и')
    .replace(/є/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function numberQty(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? '0').replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function displayQty(value: unknown): string {
  const qty = numberQty(value)
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(3)))
}

function scopeValue(value: unknown): string | null {
  const clean = String(value ?? '').trim()
  return clean || null
}

function searchText(item: Pick<LocalSupplierCatalogItem, 'sku' | 'barcode' | 'brand' | 'name' | 'warehouse_name'>): string {
  return normalizeLocalSupplierName([
    item.sku,
    item.barcode,
    item.brand,
    item.name,
    item.warehouse_name,
  ].filter(Boolean).join(' '))
}

class ExactIdentityIndex {
  private readonly candidates = new Map<string, IdentityCandidate>()
  private readonly byBarcode = new Map<string, Set<string>>()
  private readonly bySku = new Map<string, Set<string>>()
  private readonly byName = new Map<string, Set<string>>()

  constructor(candidates: IdentityCandidate[] = []) {
    for (const candidate of candidates) this.add(candidate)
  }

  add(candidate: IdentityCandidate): void {
    this.remove(candidate.id)
    this.candidates.set(candidate.id, candidate)
    for (const barcode of [candidate.barcode, ...(candidate.additional_barcodes ?? [])]) {
      this.addKey(this.byBarcode, normalizeLocalSupplierBarcode(barcode), candidate.id)
    }
    this.addKey(this.bySku, normalizeLocalSupplierSku(candidate.sku), candidate.id)
    this.addKey(this.byName, normalizeLocalSupplierName(candidate.name), candidate.id)
  }

  remove(id: string): void {
    if (!this.candidates.has(id)) return
    this.candidates.delete(id)
    for (const index of [this.byBarcode, this.bySku, this.byName]) {
      for (const [key, ids] of index) {
        ids.delete(id)
        if (ids.size === 0) index.delete(key)
      }
    }
  }

  match(input: { sku?: string; barcode?: string | null; name: string }, label = 'товар'): ExactMatch {
    const barcode = normalizeLocalSupplierBarcode(input.barcode)
    const sku = normalizeLocalSupplierSku(input.sku)
    const barcodeIds = this.ids(this.byBarcode, barcode)
    const skuIds = this.ids(this.bySku, sku)
    if (barcodeIds.length > 1) {
      return { candidate: null, kind: null, error: `Штрихкод «${barcode}» збігається з кількома ${label}ами` }
    }
    if (skuIds.length > 1) {
      return { candidate: null, kind: null, error: `Артикул «${sku}» збігається з кількома ${label}ами` }
    }
    if (barcodeIds[0] && skuIds[0] && barcodeIds[0] !== skuIds[0]) {
      return { candidate: null, kind: null, error: 'Штрихкод і артикул вказують на різні товари' }
    }
    const identifierId = barcodeIds[0] ?? skuIds[0]
    if (identifierId) {
      return {
        candidate: this.candidates.get(identifierId) ?? null,
        kind: barcodeIds[0] ? 'barcode' : 'sku',
        error: null,
      }
    }

    const name = normalizeLocalSupplierName(input.name)
    const nameIds = this.ids(this.byName, name)
    if (nameIds.length > 1) {
      return { candidate: null, kind: null, error: `Повна назва «${input.name.trim()}» збігається з кількома ${label}ами` }
    }
    return nameIds[0]
      ? { candidate: this.candidates.get(nameIds[0]) ?? null, kind: 'name', error: null }
      : { candidate: null, kind: null, error: null }
  }

  private addKey(index: Map<string, Set<string>>, key: string, id: string): void {
    if (!key) return
    const ids = index.get(key) ?? new Set<string>()
    ids.add(id)
    index.set(key, ids)
  }

  private ids(index: Map<string, Set<string>>, key: string): string[] {
    return key ? [...(index.get(key) ?? [])] : []
  }
}

export class LocalSupplierCatalogRepository {
  constructor(private readonly db: LocalDatabase) {}

  list(options: {
    tenant_id?: string
    query?: string
    supplier_id?: string | null
    page?: number
    limit?: number
  } = {}): { data: LocalSupplierCatalogItem[]; pagination: { page: number; limit: number; total: number } } {
    const tenantId = options.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Math.floor(options.page ?? 1))
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 25)))
    const where = ['i.tenant_id = ?', 'i.deleted_at IS NULL']
    const params: Array<string | number | null> = [tenantId]
    if (options.supplier_id) {
      where.push('i.supplier_id = ?')
      params.push(options.supplier_id)
    }
    const query = normalizeLocalSupplierName(options.query)
    if (query) {
      where.push("i.search_text LIKE ? ESCAPE '\\'")
      params.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`)
    }
    const whereSql = where.join(' AND ')
    const total = Number((this.db.prepare(`SELECT count(*) AS count FROM supplier_price_items i WHERE ${whereSql}`)
      .get(...params) as { count: number }).count)
    const rows = this.db.prepare(`
      SELECT i.*, s.name AS supplier_name
      FROM supplier_price_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id AND s.deleted_at IS NULL
      WHERE ${whereSql}
      ORDER BY i.updated_at DESC, i.id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit) as any[]

    const productIndex = this.productIndex(tenantId)
    return {
      data: rows.map((row) => this.decorate(row, productIndex)),
      pagination: { page, limit, total },
    }
  }

  listImports(tenantId = DEFAULT_TENANT_ID, limit = 50): LocalSupplierPriceImport[] {
    const rows = this.db.prepare(`
      SELECT i.*, s.name AS supplier_name
      FROM supplier_price_imports i
      LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id AND s.deleted_at IS NULL
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL
      ORDER BY i.created_at DESC
      LIMIT ?
    `).all(tenantId, Math.max(1, Math.min(200, limit))) as any[]
    return rows.map((row) => this.decorateImport(row))
  }

  getImport(id: string, tenantId = DEFAULT_TENANT_ID): LocalSupplierPriceImport | null {
    const row = this.db.prepare(`
      SELECT i.*, s.name AS supplier_name
      FROM supplier_price_imports i
      LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id AND s.deleted_at IS NULL
      WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any
    return row ? this.decorateImport(row) : null
  }

  create(input: LocalSupplierCatalogItemInput): LocalSupplierCatalogItem {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const normalized = this.normalizeInput(input, tenantId)
    const draftMatch = this.draftIndex(tenantId, normalized.supplier_id, normalized.warehouse_name).match(normalized, 'черновими позиці')
    if (draftMatch.error) throw new Error(draftMatch.error)
    if (draftMatch.candidate) throw new Error('Така чернова позиція вже існує у вибраному прайсі')
    const match = this.productIndex(tenantId).match(normalized)
    const id = randomUUID()
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.insertItem({ id, tenantId, normalized, match, timestamp })
      this.addOutbox(tenantId, 'supplier_catalog_item', id, 'supplier_catalog.item_upserted', {
        id, ...normalized,
      }, timestamp)
    })
    return this.requireItem(id, tenantId)
  }

  update(id: string, input: Partial<LocalSupplierCatalogItemInput>, tenantId = DEFAULT_TENANT_ID): LocalSupplierCatalogItem {
    const current = this.requireItem(id, tenantId)
    const normalized = this.normalizeInput({ ...current, ...input, tenant_id: tenantId }, tenantId)
    const drafts = this.activeScopeRows(tenantId, normalized.supplier_id, normalized.warehouse_name)
      .filter((row) => row.id !== id)
    const draftMatch = new ExactIdentityIndex(drafts).match(normalized, 'черновими позиці')
    if (draftMatch.error) throw new Error(draftMatch.error)
    if (draftMatch.candidate) throw new Error('Така чернова позиція вже існує у вибраному прайсі')
    const match = this.productIndex(tenantId).match(normalized)
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.updateItem(id, tenantId, normalized, match, timestamp)
      this.addOutbox(tenantId, 'supplier_catalog_item', id, 'supplier_catalog.item_upserted', {
        id, ...normalized,
      }, timestamp)
    })
    return this.requireItem(id, tenantId)
  }

  delete(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE supplier_price_items
        SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, id, tenantId)
      if (Number(result.changes) === 0) throw new Error('Чернову позицію не знайдено')
      this.addOutbox(tenantId, 'supplier_catalog_item', id, 'supplier_catalog.item_deleted', { id }, timestamp)
    })
    return { ok: true }
  }

  importRows(filename: string, rows: LocalSupplierImportRow[], options: LocalSupplierImportOptions): { success: true; importId: string } {
    if (rows.length === 0) throw new Error('Не знайдено товарних рядків для імпорту')
    const tenantId = options.tenant_id ?? DEFAULT_TENANT_ID
    const supplierId = this.validReference('suppliers', options.supplier_id, tenantId)
    const warehouseName = scopeValue(options.warehouse_name)
    const timestamp = nowIso()
    const importId = randomUUID()
    const errors = [...(options.parse_errors ?? [])]
    const changedItems: Array<Record<string, unknown>> = []
    const productIndex = this.productIndex(tenantId)

    this.db.transaction(() => {
      if (options.mode === 'replace') {
        this.db.prepare(`
          UPDATE supplier_price_items
          SET deleted_at = ?, dirty_at = ?, updated_at = ?
          WHERE tenant_id = ? AND supplier_id IS ? AND warehouse_name IS ? AND deleted_at IS NULL
        `).run(timestamp, timestamp, timestamp, tenantId, supplierId, warehouseName)
      }

      const activeRows = options.mode === 'add'
        ? this.activeScopeRows(tenantId, supplierId, warehouseName)
        : []
      const draftIndex = new ExactIdentityIndex(activeRows)

      for (const row of rows) {
        const normalized = this.normalizeInput({
          tenant_id: tenantId,
          supplier_id: supplierId,
          sku: row.sku?.trim() || `IMP-${randomUUID().replace(/-/g, '').toUpperCase()}`,
          barcode: row.barcode,
          brand: row.brand,
          name: row.name,
          price_kopecks: row.price_kopecks,
          qty: row.qty,
          warehouse_name: warehouseName,
        }, tenantId)
        const productMatch = productIndex.match(normalized)
        if (productMatch.error) errors.push({ row: row.source_row, error: productMatch.error })
        const draftMatch = draftIndex.match(normalized, 'черновими позиці')
        if (draftMatch.error) {
          errors.push({ row: row.source_row, error: `Дублікат у прайсі: ${draftMatch.error}` })
          continue
        }

        const existingId = draftMatch.candidate?.id
        const nextQty = existingId && options.mode === 'add'
          ? displayQty(numberQty((this.requireItem(existingId, tenantId)).qty) + numberQty(normalized.qty))
          : normalized.qty
        const next = { ...normalized, qty: nextQty }
        const itemId = existingId ?? randomUUID()
        if (existingId) this.updateItem(itemId, tenantId, next, productMatch, timestamp)
        else this.insertItem({ id: itemId, tenantId, normalized: next, match: productMatch, timestamp })
        draftIndex.add({ id: itemId, sku: next.sku, barcode: next.barcode, name: next.name })
        changedItems.push({ id: itemId, ...next })
      }

      this.db.prepare(`
        INSERT INTO supplier_price_imports (
          id, tenant_id, supplier_id, filename, mode, warehouse_name, status,
          total_rows, processed_rows, errors_json, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
      `).run(
        importId, tenantId, supplierId, filename.trim() || 'import.csv', options.mode, warehouseName,
        rows.length + (options.parse_errors?.length ?? 0), changedItems.length,
        JSON.stringify(errors), timestamp, timestamp, timestamp,
      )
      this.addOutbox(tenantId, 'supplier_catalog_import', importId, 'supplier_catalog.imported', {
        import: {
          id: importId,
          supplier_id: supplierId,
          filename: filename.trim() || 'import.csv',
          status: 'completed',
          total_rows: rows.length + (options.parse_errors?.length ?? 0),
          processed_rows: changedItems.length,
          errors_log: errors,
          created_at: timestamp,
          updated_at: timestamp,
        },
        mode: options.mode,
        warehouse_name: warehouseName,
        items: changedItems,
      }, timestamp)
    })
    return { success: true, importId }
  }

  upsertRemoteItem(item: any, tenantId: string, importedAt: string): boolean {
    if (!item?.id) return false
    const dirty = this.db.prepare('SELECT dirty_at FROM supplier_price_items WHERE id = ? AND tenant_id = ?')
      .get(item.id, tenantId) as { dirty_at: string | null } | undefined
    if (dirty?.dirty_at) return false
    const normalized = this.normalizeInput({ ...item, tenant_id: tenantId }, tenantId)
    const updatedAt = String(item.updated_at ?? importedAt)
    this.db.prepare(`
      INSERT INTO supplier_price_items (
        id, tenant_id, supplier_id, sku, barcode, brand, name, price_kopecks, qty,
        warehouse_name, matched_product_id, match_kind, match_error, search_text,
        remote_updated_at, dirty_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        supplier_id = excluded.supplier_id, sku = excluded.sku, barcode = excluded.barcode,
        brand = excluded.brand, name = excluded.name, price_kopecks = excluded.price_kopecks,
        qty = excluded.qty, warehouse_name = excluded.warehouse_name,
        search_text = excluded.search_text, remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
      WHERE supplier_price_items.dirty_at IS NULL
    `).run(
      item.id, tenantId, normalized.supplier_id, normalized.sku, normalized.barcode,
      normalized.brand, normalized.name, normalized.price_kopecks, normalized.qty,
      normalized.warehouse_name, searchText(normalized), updatedAt,
      item.created_at ?? updatedAt, updatedAt, item.deleted_at ?? null,
    )
    return true
  }

  upsertRemoteImport(record: any, tenantId: string, importedAt: string): boolean {
    if (!record?.id) return false
    const dirty = this.db.prepare('SELECT dirty_at FROM supplier_price_imports WHERE id = ? AND tenant_id = ?')
      .get(record.id, tenantId) as { dirty_at: string | null } | undefined
    if (dirty?.dirty_at) return false
    const supplierId = this.validReference('suppliers', record.supplier_id, tenantId)
    const updatedAt = String(record.updated_at ?? importedAt)
    this.db.prepare(`
      INSERT INTO supplier_price_imports (
        id, tenant_id, supplier_id, filename, mode, warehouse_name, status,
        total_rows, processed_rows, errors_json, remote_updated_at, dirty_at,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, 'add', NULL, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        supplier_id = excluded.supplier_id, filename = excluded.filename, status = excluded.status,
        total_rows = excluded.total_rows, processed_rows = excluded.processed_rows,
        errors_json = excluded.errors_json, remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at, deleted_at = NULL
      WHERE supplier_price_imports.dirty_at IS NULL
    `).run(
      record.id, tenantId, supplierId, String(record.filename ?? 'import.csv'),
      record.status ?? 'completed', Math.max(0, Number(record.total_rows) || 0),
      Math.max(0, Number(record.processed_rows) || 0), JSON.stringify(record.errors_log ?? []),
      updatedAt, record.created_at ?? updatedAt, updatedAt,
    )
    return true
  }

  private normalizeInput(input: LocalSupplierCatalogItemInput, tenantId: string) {
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error('Назва товару обов’язкова')
    const price = Math.max(0, Math.round(Number(input.price_kopecks) || 0))
    return {
      supplier_id: this.validReference('suppliers', input.supplier_id, tenantId),
      sku: normalizeLocalSupplierSku(input.sku),
      barcode: normalizeLocalSupplierBarcode(input.barcode) || null,
      brand: scopeValue(input.brand),
      name,
      price_kopecks: price,
      qty: displayQty(input.qty),
      warehouse_name: scopeValue(input.warehouse_name),
    }
  }

  private productIndex(tenantId: string): ExactIdentityIndex {
    const products = this.db.prepare(`
      SELECT id, sku, name, barcode
      FROM products
      WHERE tenant_id = ? AND deleted_at IS NULL AND is_active = 1
    `).all(tenantId) as unknown as IdentityCandidate[]
    const extra = this.db.prepare(`
      SELECT product_id, barcode
      FROM product_barcodes
      WHERE tenant_id = ? AND deleted_at IS NULL
    `).all(tenantId) as unknown as Array<{ product_id: string; barcode: string }>
    const grouped = new Map<string, string[]>()
    for (const row of extra) grouped.set(row.product_id, [...(grouped.get(row.product_id) ?? []), row.barcode])
    return new ExactIdentityIndex(products.map((product) => ({
      ...product,
      additional_barcodes: grouped.get(product.id) ?? [],
    })))
  }

  private draftIndex(tenantId: string, supplierId: string | null, warehouseName: string | null): ExactIdentityIndex {
    return new ExactIdentityIndex(this.activeScopeRows(tenantId, supplierId, warehouseName))
  }

  private activeScopeRows(tenantId: string, supplierId: string | null, warehouseName: string | null): IdentityCandidate[] {
    return this.db.prepare(`
      SELECT id, sku, name, barcode
      FROM supplier_price_items
      WHERE tenant_id = ? AND supplier_id IS ? AND warehouse_name IS ? AND deleted_at IS NULL
    `).all(tenantId, supplierId, warehouseName) as unknown as IdentityCandidate[]
  }

  private insertItem(args: {
    id: string
    tenantId: string
    normalized: ReturnType<LocalSupplierCatalogRepository['normalizeInput']>
    match: ExactMatch
    timestamp: string
  }): void {
    const { id, tenantId, normalized, match, timestamp } = args
    this.db.prepare(`
      INSERT INTO supplier_price_items (
        id, tenant_id, supplier_id, sku, barcode, brand, name, price_kopecks, qty,
        warehouse_name, matched_product_id, match_kind, match_error, search_text,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, normalized.supplier_id, normalized.sku, normalized.barcode,
      normalized.brand, normalized.name, normalized.price_kopecks, normalized.qty,
      normalized.warehouse_name, match.candidate?.id ?? null, match.kind, match.error,
      searchText(normalized), timestamp, timestamp, timestamp,
    )
  }

  private updateItem(
    id: string,
    tenantId: string,
    normalized: ReturnType<LocalSupplierCatalogRepository['normalizeInput']>,
    match: ExactMatch,
    timestamp: string,
  ): void {
    this.db.prepare(`
      UPDATE supplier_price_items SET
        supplier_id = ?, sku = ?, barcode = ?, brand = ?, name = ?, price_kopecks = ?,
        qty = ?, warehouse_name = ?, matched_product_id = ?, match_kind = ?, match_error = ?,
        search_text = ?, dirty_at = ?, updated_at = ?, deleted_at = NULL
      WHERE id = ? AND tenant_id = ?
    `).run(
      normalized.supplier_id, normalized.sku, normalized.barcode, normalized.brand,
      normalized.name, normalized.price_kopecks, normalized.qty, normalized.warehouse_name,
      match.candidate?.id ?? null, match.kind, match.error, searchText(normalized),
      timestamp, timestamp, id, tenantId,
    )
  }

  private requireItem(id: string, tenantId: string): LocalSupplierCatalogItem {
    const row = this.db.prepare(`
      SELECT i.*, s.name AS supplier_name
      FROM supplier_price_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id AND s.deleted_at IS NULL
      WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any
    if (!row) throw new Error('Чернову позицію не знайдено')
    return this.decorate(row, this.productIndex(tenantId))
  }

  private decorate(row: any, productIndex: ExactIdentityIndex): LocalSupplierCatalogItem {
    const match = productIndex.match(row)
    return {
      id: String(row.id),
      tenant_id: String(row.tenant_id),
      supplier_id: row.supplier_id ?? null,
      sku: String(row.sku ?? ''),
      barcode: row.barcode ?? null,
      brand: row.brand ?? null,
      name: String(row.name ?? ''),
      price_kopecks: Number(row.price_kopecks ?? 0),
      qty: displayQty(row.qty),
      warehouse_name: row.warehouse_name ?? null,
      matched_product_id: match.candidate?.id ?? null,
      match_kind: match.kind,
      match_error: match.error,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      ...(row.supplier_id && row.supplier_name
        ? { supplier: { id: String(row.supplier_id), name: String(row.supplier_name) } }
        : {}),
    }
  }

  private decorateImport(row: any): LocalSupplierPriceImport {
    let errors: LocalSupplierPriceImport['errors_log'] = []
    try { errors = JSON.parse(String(row.errors_json ?? '[]')) } catch {}
    return {
      id: String(row.id), tenant_id: String(row.tenant_id), supplier_id: row.supplier_id ?? null,
      filename: String(row.filename), status: row.status, total_rows: Number(row.total_rows ?? 0),
      processed_rows: Number(row.processed_rows ?? 0), errors_log: Array.isArray(errors) ? errors : [],
      created_at: String(row.created_at), updated_at: String(row.updated_at),
      ...(row.supplier_id && row.supplier_name
        ? { suppliers: { id: String(row.supplier_id), name: String(row.supplier_name) } }
        : {}),
    }
  }

  private validReference(table: 'suppliers', id: unknown, tenantId: string): string | null {
    const value = scopeValue(id)
    if (!value) return null
    const row = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(value, tenantId)
    return row ? value : null
  }

  private addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(), tenantId, this.db.deviceId, aggregateType, aggregateId,
      operationType, JSON.stringify(payload), timestamp,
    )
  }
}
