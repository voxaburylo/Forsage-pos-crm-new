import { randomUUID } from 'node:crypto'
import {
  catalogCopyRows, validateCatalogRecord, catalogTimestamp, remoteCatalogIsOlder,
  verifyCatalogVersionContent, catalogHistoryCount, catalogHistoryErrors, catalogCopyText, invalidCatalogCopy,
} from './supplierCatalogRemoteValidation'
import { runCatalogImport, resolveCatalogImport, type CatalogImportResult } from './supplierCatalogImportRecovery'
import { SupplierCatalogWriteGuard, catalogWriteConflict } from './supplierCatalogWriteSafety'
import { addCatalogQuantity, catalogPriceKopecks, catalogQuantity } from '../lib/supplierCatalogNumbers'
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
  operation_id?: string
  user_id?: string
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
    const previous = this.candidates.get(id)
    if (!previous) return
    this.candidates.delete(id)
    const removeKey = (index: Map<string, Set<string>>, key: string) => {
      const ids = index.get(key)
      if (!ids) return
      ids.delete(id)
      if (!ids.size) index.delete(key)
    }
    for (const barcode of [previous.barcode, ...(previous.additional_barcodes ?? [])])
      removeKey(this.byBarcode, normalizeLocalSupplierBarcode(barcode))
    removeKey(this.bySku, normalizeLocalSupplierSku(previous.sku))
    removeKey(this.byName, normalizeLocalSupplierName(previous.name))
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
    return this.db.transaction(() => {
      const guard = new SupplierCatalogWriteGuard(this.db)
      const normalized = this.normalizeInput(input, tenantId)
      const draftMatch = this.draftIndex(tenantId, normalized.supplier_id, normalized.warehouse_name).match(normalized, 'черновими позиці')
      if (draftMatch.error) throw new Error(draftMatch.error)
      if (draftMatch.candidate) throw new Error('Така чернова позиція вже існує у вибраному прайсі')
      const match = this.productIndex(tenantId).match(normalized)
      const id = randomUUID(), timestamp = nowIso()
      this.insertItem({ id, tenantId, normalized, match, timestamp }, guard)
      this.addOutbox(tenantId, 'supplier_catalog_item', id, 'supplier_catalog.item_upserted', {
        id, ...normalized,
      }, timestamp, guard)
      guard.verify()
      return this.requireItem(id, tenantId)
    })
  }

  update(id: string, input: Partial<LocalSupplierCatalogItemInput>, tenantId = DEFAULT_TENANT_ID): LocalSupplierCatalogItem {
    return this.db.transaction(() => {
      const guard = new SupplierCatalogWriteGuard(this.db)
      const current = this.requireItem(id, tenantId)
      const normalized = this.normalizeInput({ ...current, ...input, tenant_id: tenantId }, tenantId)
      const drafts = this.activeScopeRows(tenantId, normalized.supplier_id, normalized.warehouse_name).filter(row => row.id !== id)
      const draftMatch = new ExactIdentityIndex(drafts).match(normalized, 'черновими позиці')
      if (draftMatch.error) throw new Error(draftMatch.error)
      if (draftMatch.candidate) throw new Error('Така чернова позиція вже існує у вибраному прайсі')
      const match = this.productIndex(tenantId).match(normalized), timestamp = nowIso()
      this.updateItem(id, tenantId, normalized, match, timestamp, guard)
      this.addOutbox(tenantId, 'supplier_catalog_item', id, 'supplier_catalog.item_upserted', {
        id, ...normalized,
      }, timestamp, guard)
      guard.verify()
      return this.requireItem(id, tenantId)
    })
  }

  delete(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    this.db.transaction(() => {
      const guard = new SupplierCatalogWriteGuard(this.db)
      const before = guard.item(id), timestamp = nowIso()
      if (!before || before.tenant_id !== tenantId || before.deleted_at) throw new Error('Чернову позицію не знайдено')
      const result = this.db.prepare(`
        UPDATE supplier_price_items SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, id, tenantId)
      guard.written(result)
      guard.expectItem({ ...before, deleted_at: timestamp, dirty_at: timestamp, updated_at: timestamp })
      this.addOutbox(tenantId, 'supplier_catalog_item', id, 'supplier_catalog.item_deleted', { id }, timestamp, guard)
      guard.verify()
    })
    return { ok: true }
  }

  resolveImport(operationId: string, userId: string, tenantId = DEFAULT_TENANT_ID) {
    return resolveCatalogImport(this.db, tenantId, userId, operationId)
  }

  importRows(filename: string, rows: LocalSupplierImportRow[], options: LocalSupplierImportOptions): CatalogImportResult {
    // Internal legacy callers remain valid; the current IPC requires an operation ID.
    if (options.operation_id !== undefined) return runCatalogImport(this.db,
      options.tenant_id ?? DEFAULT_TENANT_ID, options.user_id, options.operation_id,
      { filename, rows, options: { ...options, operation_id: undefined } },
      capture => this.importRowsInTransaction(filename, rows, options, capture))
    return this.importRowsInTransaction(filename, rows, options)
  }

  private importRowsInTransaction(filename: string, rows: LocalSupplierImportRow[], options: LocalSupplierImportOptions,
    capture?: (guard: SupplierCatalogWriteGuard) => void): CatalogImportResult {
    if (rows.length === 0) throw new Error('Не знайдено товарних рядків для імпорту')
    if (options.parse_errors?.length) {
      const first = options.parse_errors[0]
      throw new Error(`Рядок ${first.row}: ${first.error}. Виправте файл; прайс не змінено.`)
    }
    if (options.mode !== 'add' && options.mode !== 'replace') throw new Error('Некоректний режим імпорту прайсу')
    const tenantId = options.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso(), importId = randomUUID()
    this.db.transaction(() => {
      const guard = new SupplierCatalogWriteGuard(this.db)
      const supplierId = this.validReference('suppliers', options.supplier_id, tenantId)
      const warehouseName = scopeValue(options.warehouse_name)
      const errors: Array<{ row: number; error: string }> = []
      const changedItems = new Map<string, Record<string, unknown>>()
      const productIndex = this.productIndex(tenantId)
      const activeRows = this.db.prepare(`
        SELECT * FROM supplier_price_items
        WHERE tenant_id = ? AND supplier_id IS ? AND warehouse_name IS ? AND deleted_at IS NULL
      `).all(tenantId, supplierId, warehouseName) as Array<Record<string, any>>
      for (const row of activeRows) guard.expectItem(row)

      if (options.mode === 'replace') {
        const retired = this.db.prepare(`
          UPDATE supplier_price_items SET deleted_at = ?, dirty_at = ?, updated_at = ?
          WHERE tenant_id = ? AND supplier_id IS ? AND warehouse_name IS ? AND deleted_at IS NULL
        `).run(timestamp, timestamp, timestamp, tenantId, supplierId, warehouseName)
        guard.written(retired, activeRows.length)
        for (const row of activeRows) guard.expectItem({ ...row, deleted_at: timestamp, dirty_at: timestamp, updated_at: timestamp })
      }
      const draftIndex = new ExactIdentityIndex(options.mode === 'add' ? activeRows as IdentityCandidate[] : [])
      for (const row of rows) {
        const normalized = this.normalizeInput({
          tenant_id: tenantId, supplier_id: supplierId,
          sku: row.sku?.trim() || `IMP-${randomUUID().replace(/-/g, '').toUpperCase()}`,
          barcode: row.barcode, brand: row.brand, name: row.name,
          price_kopecks: row.price_kopecks, qty: row.qty, warehouse_name: warehouseName,
        }, tenantId)
        const productMatch = productIndex.match(normalized)
        if (productMatch.error) errors.push({ row: row.source_row, error: productMatch.error })
        const draftMatch = draftIndex.match(normalized, 'черновими позиці')
        if (draftMatch.error) throw new Error(`Рядок ${row.source_row}: Дублікат у прайсі: ${draftMatch.error}. Прайс не змінено.`)
        const existingId = draftMatch.candidate?.id
        // Accumulate from the initial/planned state, never from an unverified write.
        const previous = existingId ? guard.item(existingId) : undefined
        if (existingId && !previous) throw catalogWriteConflict()
        const next = { ...normalized, qty: existingId ? addCatalogQuantity(previous!.qty, normalized.qty) : normalized.qty }
        const itemId = existingId ?? randomUUID()
        if (existingId) this.updateItem(itemId, tenantId, next, productMatch, timestamp, guard)
        else this.insertItem({ id: itemId, tenantId, normalized: next, match: productMatch, timestamp }, guard)
        draftIndex.add({ id: itemId, sku: next.sku, barcode: next.barcode, name: next.name })
        changedItems.set(itemId, { id: itemId, ...next })
      }

      const name = filename.trim() || 'import.csv'
      const inserted = this.db.prepare(`
        INSERT INTO supplier_price_imports (
          id, tenant_id, supplier_id, filename, mode, warehouse_name, status,
          total_rows, processed_rows, errors_json, dirty_at, created_at, updated_at, scope_known
        ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, 1)
      `).run(importId, tenantId, supplierId, name, options.mode, warehouseName,
        rows.length, rows.length, JSON.stringify(errors), timestamp, timestamp, timestamp)
      guard.written(inserted)
      guard.expectImport({
        id: importId, tenant_id: tenantId, supplier_id: supplierId, filename: name,
        mode: options.mode, warehouse_name: warehouseName, status: 'completed',
        total_rows: rows.length, processed_rows: rows.length, errors_json: JSON.stringify(errors),
        remote_updated_at: null, dirty_at: timestamp, created_at: timestamp, updated_at: timestamp,
        deleted_at: null, scope_known: 1,
      })
      this.addOutbox(tenantId, 'supplier_catalog_import', importId, 'supplier_catalog.imported', {
        import: {
          id: importId, supplier_id: supplierId, filename: name, status: 'completed',
          total_rows: rows.length, processed_rows: rows.length, errors_log: errors,
          created_at: timestamp, updated_at: timestamp,
        },
        mode: options.mode, warehouse_name: warehouseName, items: [...changedItems.values()],
      }, timestamp, guard)
      guard.verify()
      capture?.(guard)
    })
    return { success: true, importId }
  }

  /** One catalog batch inside the enclosing pull/bootstrap transaction. */
  applyRemoteCopy(items: unknown, imports: unknown, tenantId: string, importedAt: string) {
    const itemRows = catalogCopyRows(items), importRows = catalogCopyRows(imports)
    return this.db.transaction(() => {
      const guard = new SupplierCatalogWriteGuard(this.db)
      const counts = { supplier_price_items: 0, supplier_price_imports: 0 }
      for (const item of itemRows) if (this.upsertRemoteItem(item, tenantId, importedAt, guard)) counts.supplier_price_items++
      for (const record of importRows) if (this.upsertRemoteImport(record, tenantId, importedAt, guard)) counts.supplier_price_imports++
      guard.verify()
      // Called again before the enclosing COMMIT, after secondary/cursor writes.
      return { counts, verify: () => guard.verifyStoredRows() }
    })
  }

  upsertRemoteItem(item: any, tenantId: string, importedAt: string, batch?: SupplierCatalogWriteGuard): boolean {
    const work = () => {
      const guard = batch ?? new SupplierCatalogWriteGuard(this.db)
      const previous = this.remoteCatalogOwner('supplier_price_items', item, tenantId, guard)
      if (previous?.dirty_at) return false
      const updatedAt = catalogTimestamp(item.updated_at ?? previous?.remote_updated_at ?? previous?.updated_at ?? item.created_at ?? importedAt)
      if (remoteCatalogIsOlder(previous, updatedAt)) return false
      const fields = { ...item }
      for (const key of ['name', 'sku', 'barcode', 'brand', 'warehouse_name', 'supplier_id', 'qty', 'price_kopecks'])
        if (fields[key] === undefined && previous) fields[key] = previous[key]
      for (const key of ['sku', 'barcode', 'brand', 'warehouse_name'])
        if (fields[key] !== undefined) catalogCopyText(fields[key])
      catalogCopyText(fields.name, false)
      if (fields.qty === undefined) throw invalidCatalogCopy()
      const normalized = this.normalizeInput({ ...fields, tenant_id: tenantId }, tenantId, true)
      const expected = {
        id: item.id, tenant_id: tenantId, ...normalized, qty: Number(normalized.qty),
        matched_product_id: previous?.matched_product_id ?? null,
        match_kind: previous?.match_kind ?? null, match_error: previous?.match_error ?? null,
        search_text: searchText(normalized), remote_updated_at: updatedAt, dirty_at: null,
        created_at: previous?.created_at ?? catalogTimestamp(item.created_at ?? updatedAt),
        updated_at: updatedAt,
        deleted_at: Object.hasOwn(item, 'deleted_at')
          ? (item.deleted_at === null ? null : catalogTimestamp(item.deleted_at)) : previous?.deleted_at ?? null,
      }
      verifyCatalogVersionContent(previous, expected, item.updated_at != null)
      const result = this.db.prepare(`
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
        WHERE supplier_price_items.tenant_id = excluded.tenant_id AND supplier_price_items.dirty_at IS NULL
      `).run(
        expected.id, tenantId, expected.supplier_id, expected.sku, expected.barcode,
        expected.brand, expected.name, expected.price_kopecks, expected.qty,
        expected.warehouse_name, expected.search_text, updatedAt,
        expected.created_at, updatedAt, expected.deleted_at,
      )
      guard.written(result)
      guard.expectItem(expected)
      if (!batch) guard.verify()
      return true
    }
    return batch ? work() : this.db.transaction(work)
  }

  upsertRemoteImport(record: any, tenantId: string, importedAt: string, batch?: SupplierCatalogWriteGuard): boolean {
    const work = () => {
      const guard = batch ?? new SupplierCatalogWriteGuard(this.db)
      const previous = this.remoteCatalogOwner('supplier_price_imports', record, tenantId, guard)
      if (previous?.dirty_at) return false
      const updatedAt = catalogTimestamp(record.updated_at ?? previous?.remote_updated_at ?? previous?.updated_at ?? record.created_at ?? importedAt)
      if (remoteCatalogIsOlder(previous, updatedAt)) return false
      if (record.mode != null && record.mode !== 'add' && record.mode !== 'replace')
        throw new Error('Некоректний режим імпорту прайсу; історію не змінено.')
      if (record.warehouse_name != null && typeof record.warehouse_name !== 'string')
        throw new Error('Некоректний склад імпорту прайсу; історію не змінено.')
      const completeScope = record.mode != null && Object.hasOwn(record, 'warehouse_name')
      if (record.mode != null && !completeScope)
        throw new Error('Неповні дані складу імпорту прайсу; історію не змінено.')
      const mode = completeScope ? record.mode : previous?.mode ?? 'add'
      const warehouseName = completeScope ? scopeValue(record.warehouse_name) : previous?.warehouse_name ?? null
      const scopeKnown = completeScope ? 1 : previous?.scope_known ?? 0
      if (completeScope && previous?.scope_known
        && (previous.mode !== mode || previous.warehouse_name !== warehouseName))
        throw new Error('Конфлікт режиму або складу імпорту прайсу; історію не змінено.')
      const supplierId = this.validReference('suppliers',
        Object.hasOwn(record, 'supplier_id') ? record.supplier_id : previous?.supplier_id, tenantId, true)
      if (previous && previous.supplier_id !== supplierId) throw invalidCatalogCopy()
      const total = catalogHistoryCount(record.total_rows === undefined ? previous?.total_rows ?? 0 : record.total_rows)
      const processed = catalogHistoryCount(record.processed_rows === undefined ? previous?.processed_rows ?? 0 : record.processed_rows)
      if (processed > total) throw invalidCatalogCopy()
      const status = record.status === undefined ? previous?.status ?? 'completed' : record.status
      if (!['pending', 'processing', 'completed', 'failed'].includes(status)) throw invalidCatalogCopy()
      const expected = {
        id: record.id, tenant_id: tenantId, supplier_id: supplierId,
        filename: record.filename === undefined ? previous?.filename ?? 'import.csv' : catalogCopyText(record.filename, false),
        mode, warehouse_name: warehouseName, scope_known: scopeKnown, status,
        total_rows: total, processed_rows: processed,
        errors_json: record.errors_log === undefined ? previous?.errors_json ?? '[]' : catalogHistoryErrors(record.errors_log),
        remote_updated_at: updatedAt, dirty_at: null,
        created_at: previous?.created_at ?? catalogTimestamp(record.created_at ?? updatedAt),
        updated_at: updatedAt,
        deleted_at: Object.hasOwn(record, 'deleted_at')
          ? (record.deleted_at === null ? null : catalogTimestamp(record.deleted_at)) : previous?.deleted_at ?? null,
      }
      verifyCatalogVersionContent(previous, expected, record.updated_at != null)
      const result = this.db.prepare(`
        INSERT INTO supplier_price_imports (
          id, tenant_id, supplier_id, filename, mode, warehouse_name, status,
          total_rows, processed_rows, errors_json, remote_updated_at, dirty_at,
          created_at, updated_at, deleted_at, scope_known
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          supplier_id = excluded.supplier_id, filename = excluded.filename, status = excluded.status,
          mode = excluded.mode, warehouse_name = excluded.warehouse_name, scope_known = excluded.scope_known,
          total_rows = excluded.total_rows, processed_rows = excluded.processed_rows,
          errors_json = excluded.errors_json, remote_updated_at = excluded.remote_updated_at,
          updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
        WHERE supplier_price_imports.tenant_id = excluded.tenant_id AND supplier_price_imports.dirty_at IS NULL
      `).run(
        expected.id, tenantId, supplierId, expected.filename, mode, warehouseName,
        status, total, processed, expected.errors_json,
        updatedAt, expected.created_at, updatedAt, expected.deleted_at, scopeKnown,
      )
      guard.written(result)
      guard.expectImport(expected)
      if (!batch) guard.verify()
      return true
    }
    return batch ? work() : this.db.transaction(work)
  }

  private remoteCatalogOwner(table: 'supplier_price_items' | 'supplier_price_imports', record: any,
    tenantId: string, guard: SupplierCatalogWriteGuard) {
    validateCatalogRecord(record)
    const existing = table === 'supplier_price_items' ? guard.item(record.id) : guard.import(record.id)
    if ((record.tenant_id !== undefined && record.tenant_id !== tenantId) || (existing && existing.tenant_id !== tenantId))
      throw new Error('Запис прайсу належить іншій організації. Копію не застосовано; дані не змінено.')
    return existing
  }

  private normalizeInput(input: LocalSupplierCatalogItemInput, tenantId: string, historical = false) {
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error('Назва товару обов’язкова')
    const price = catalogPriceKopecks(input.price_kopecks)
    return {
      supplier_id: this.validReference('suppliers', input.supplier_id, tenantId, historical),
      sku: normalizeLocalSupplierSku(input.sku),
      barcode: normalizeLocalSupplierBarcode(input.barcode) || null,
      brand: scopeValue(input.brand),
      name,
      price_kopecks: price,
      qty: catalogQuantity(input.qty),
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
  }, guard: SupplierCatalogWriteGuard): void {
    const { id, tenantId, normalized, match, timestamp } = args
    const expected = {
      id, tenant_id: tenantId, ...normalized, qty: Number(normalized.qty),
      matched_product_id: match.candidate?.id ?? null, match_kind: match.kind, match_error: match.error,
      search_text: searchText(normalized), remote_updated_at: null, dirty_at: timestamp,
      created_at: timestamp, updated_at: timestamp, deleted_at: null,
    }
    const inserted = this.db.prepare(`
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
    guard.written(inserted)
    guard.expectItem(expected)
  }

  private updateItem(
    id: string, tenantId: string,
    normalized: ReturnType<LocalSupplierCatalogRepository['normalizeInput']>,
    match: ExactMatch, timestamp: string, guard: SupplierCatalogWriteGuard,
  ): void {
    const before = guard.item(id)
    if (!before || before.tenant_id !== tenantId || before.deleted_at) throw catalogWriteConflict()
    const expected = {
      ...before, ...normalized, qty: Number(normalized.qty),
      matched_product_id: match.candidate?.id ?? null, match_kind: match.kind, match_error: match.error,
      search_text: searchText(normalized), dirty_at: timestamp, updated_at: timestamp, deleted_at: null,
    }
    const updated = this.db.prepare(`
      UPDATE supplier_price_items SET
        supplier_id = ?, sku = ?, barcode = ?, brand = ?, name = ?, price_kopecks = ?,
        qty = ?, warehouse_name = ?, matched_product_id = ?, match_kind = ?, match_error = ?,
        search_text = ?, dirty_at = ?, updated_at = ?, deleted_at = NULL
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(
      normalized.supplier_id, normalized.sku, normalized.barcode, normalized.brand,
      normalized.name, normalized.price_kopecks, normalized.qty, normalized.warehouse_name,
      match.candidate?.id ?? null, match.kind, match.error, searchText(normalized),
      timestamp, timestamp, id, tenantId,
    )
    guard.written(updated)
    guard.expectItem(expected)
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
      // Show legacy values as stored; never silently round/zero them on read.
      qty: String(row.qty ?? ''),
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

  private validReference(table: 'suppliers', id: unknown, tenantId: string, historical = false): string | null {
    const value = scopeValue(id)
    if (!value) return null
    // Existing archived parents are legitimate in historical copies; preserve their ID.
    // New edits still require an active supplier. A merged source must never gain new references.
    const active = historical ? '' : ' AND deleted_at IS NULL AND is_active = 1'
    const row = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ?${active} LIMIT 1`)
      .get(value, tenantId)
    const merged = historical && this.db.prepare('SELECT 1 FROM app_meta WHERE key=?')
      .get('supplier-merge:' + tenantId + ':' + value)
    // A stale selection must not become the unassigned scope, especially in replace mode.
    if (!row || merged) throw new Error('Постачальник недоступний. Оновіть список і виберіть активну картку; прайс не змінено.')
    return value
  }

  private addOutbox(
    tenantId: string, aggregateType: string, aggregateId: string,
    operationType: string, payload: unknown, timestamp: string, guard: SupplierCatalogWriteGuard,
  ): void {
    const operationId = randomUUID(), payloadJson = JSON.stringify(payload)
    const inserted = this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(operationId, tenantId, this.db.deviceId, aggregateType, aggregateId, operationType, payloadJson, timestamp)
    guard.written(inserted)
    const sequence = Number(inserted.lastInsertRowid)
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw catalogWriteConflict()
    guard.expectEvent({
      sequence, operation_id: operationId, tenant_id: tenantId, device_id: this.db.deviceId,
      aggregate_type: aggregateType, aggregate_id: aggregateId, operation_type: operationType,
      payload_json: payloadJson, status: 'pending', attempts: 0, next_attempt_at: null,
      created_at: timestamp, synced_at: null, last_error: null,
    })
  }
}
