import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { CatalogAgentRepository, agentFingerprint, catalogCodeFromName, missingAgentSku, normalizeAgentCode } from './catalogAgentRepository'
import { analyzeCatalogCleanup, type CleanupProduct } from './catalogCleanupMatcher'
import { idempotentMutation } from './idempotentMutation'
import { addStockQuantity, stockQuantity } from './stockQuantity'
import { checkedAiSupplyUnit } from './supplyValidation'
import { refreshProductSearchText } from './catalogRepository'
import { assertCleanupActorId, catalogCleanupManifestBlockers } from './catalogCleanupManifest'

type Row = Record<string, any>
type CatalogRow = Row & CleanupProduct
export type CleanupStockReview = 'pending' | 'checked'
export interface CleanupSelection { tenant_id: string; target_id: string; source_ids: string[]; stock_review: CleanupStockReview }
export interface CleanupApply extends CleanupSelection { operation_id: string; preview_fingerprint: string; reason: string }
export interface CleanupOptions {
  /** Only main may enable this after verifying the compatible server protocol. */
  canMirrorMerge?: () => boolean
  /** Main must inspect all persisted/live Electron cart scopes, not trust renderer claims. */
  externalBlockers?: (productIds: string[]) => string[]
}
export interface CleanupPreview {
  fingerprint: string; target_id: string; source_ids: string[]; products: Row[]
  history_counts: Record<string, number>; blockers: string[]; warnings: string[]
  quantity_before: number[]; quantity_after: number; barcodes: string[]
  photos: { product_id: string; photo_url: string }[]; can_apply: boolean; stock_review: CleanupStockReview
}
export interface CleanupMirrorPayload {
  version: 1; operation_id: string; target_id: string; source_ids: string[]
  products: Row[]; barcodes: Row[]; aliases: Row[]; cross_numbers: Row[]
  stock_review: CleanupStockReview; reason: string; user_id: string; merged_at: string
}
const metadata = ['product_barcodes', 'product_aliases', 'product_cross_numbers'] as const
const references: Record<string, string> = {
  sale_items: 'product_id', supply_invoice_items: 'product_id', customer_return_items: 'product_id',
  warehouse_movements: 'product_id', stock_reserves: 'product_id', writeoff_items: 'product_id',
  customer_order_items: 'product_id', supplier_price_items: 'matched_product_id', auto_purchase_rules: 'product_id',
  inventory_movements: 'product_id', inventory_items: 'product_id', inventory_count_entries: 'product_id',
  product_barcodes: 'product_id', product_aliases: 'product_id', product_cross_numbers: 'product_id',
}
const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function specs(row: Row): Row {
  const value = JSON.parse(row.specs_json || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Пошкоджені характеристики товару: ' + row.name)
  return value
}
function selection(input: CleanupSelection): CleanupSelection {
  if (!input || typeof input.tenant_id !== 'string' || !input.tenant_id || typeof input.target_id !== 'string'
    || !input.target_id || !Array.isArray(input.source_ids) || !input.source_ids.length || input.source_ids.length > 20
    || input.source_ids.some(id => typeof id !== 'string' || !id || id.length > 128)
    || new Set(input.source_ids).size !== input.source_ids.length || input.source_ids.includes(input.target_id)
    || !['pending', 'checked'].includes(input.stock_review)) throw new Error('Оберіть головну картку та від 1 до 20 різних дублів')
  return { tenant_id: input.tenant_id, target_id: input.target_id, source_ids: [...input.source_ids].sort(), stock_review: input.stock_review }
}
function containsProduct(value: unknown, ids: Set<string>, depth = 0): boolean {
  if (depth > 35) throw new Error('Надто складний збережений кошик — перевірте відкриті чеки')
  if (Array.isArray(value)) return value.some(item => containsProduct(item, ids, depth + 1))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) => (/^(product_?id|matched_product_id)$/i.test(key) && typeof item === 'string' && ids.has(item))
    || containsProduct(item, ids, depth + 1))
}

/** Local-authority catalog maintenance. Historical document rows are never rewritten. */
export class CatalogCleanupRepository {
  constructor(private readonly db: LocalDatabase, private readonly options: CleanupOptions = {}) {}

  scan(tenantId: string) {
    const products = this.db.prepare(`SELECT p.*,b.name AS brand FROM products p LEFT JOIN brands b
      ON b.id=p.brand_id AND b.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0
      ORDER BY p.id`).all(tenantId) as CatalogRow[]
    const codes = this.db.prepare('SELECT product_id,barcode FROM product_barcodes WHERE tenant_id=? AND deleted_at IS NULL ORDER BY barcode').all(tenantId) as Row[]
    const byProduct = new Map<string, string[]>()
    for (const code of codes) byProduct.set(code.product_id, [...(byProduct.get(code.product_id) ?? []), code.barcode])
    const summaries = products.map(row => ({ ...row, brand: row.brand ?? null,
      additional_barcodes: byProduct.get(row.id) ?? [], fingerprint: agentFingerprint(row) }))
    const analysis = analyzeCatalogCleanup(summaries)
    const productById = new Map(products.map(row => [row.id, row]))
    return { ...analysis, products: summaries,
      sku_suggestions: analysis.sku_suggestions.map(suggestion => ({ ...suggestion,
        preview_fingerprint: agentFingerprint(productById.get(suggestion.product_id)!),
        ...(!missingAgentSku(productById.get(suggestion.product_id)?.sku)
          ? { blocked: 'Ручний артикул не замінюється автоматично' } : {}),
      })) }
  }

  preview(input: CleanupSelection): CleanupPreview {
    const normalized = selection(input)
    return this.db.readSnapshot(() => this.capture(normalized).preview)
  }

  private capture(input: CleanupSelection) {
    const ids = [input.target_id, ...input.source_ids], idsSet = new Set(ids), placeholders = ids.map(() => '?').join(',')
    const products = ids.map(id => this.db.prepare(`SELECT p.*,b.name AS brand FROM products p LEFT JOIN brands b
      ON b.id=p.brand_id AND b.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.id=?`).get(input.tenant_id, id) as CatalogRow | undefined)
    if (products.some(row => !row || row.deleted_at || !row.is_active || row.is_service)) throw new Error('Картка відсутня, архівована або вже об’єднана. Оновіть перевірку.')
    const selected = products as CatalogRow[], target = selected[0], blockers: string[] = [], warnings: string[] = []
    const state: Record<string, unknown> = { input, products: selected }
    const historyCounts: Record<string, number> = {}
    for (const row of selected) {
      const data = specs(row)
      if (data.merged_into_product_id) blockers.push('Картку вже об’єднано: ' + row.name)
      try { checkedAiSupplyUnit(row.unit, target.unit, row.name) } catch (error) { blockers.push((error as Error).message) }
      if (row.brand_id && target.brand_id && row.brand_id !== target.brand_id) blockers.push('Різні бренди: ' + row.name)
      if (row.requires_core_return !== target.requires_core_return || row.core_deposit_amount !== target.core_deposit_amount) blockers.push('Різні заставні умови: ' + row.name)
      if (stockQuantity(Number(row.qty_on_hand)) < 0) blockers.push('Від’ємний залишок потрібно звірити окремо: ' + row.name)
      if (row.id !== target.id && (row.retail_price !== target.retail_price || row.purchase_price !== target.purchase_price)) warnings.push('Ціни відрізняються; залишаться ціни головної картки: ' + row.name)
    }
    if (new Set(selected.map(row => row.brand_id).filter(Boolean)).size > 1) blockers.push('У вибраній групі різні бренди')
    // Do not create hidden multi-hop identity chains for old scans/AI or return routing.
    const archived = this.db.prepare('SELECT id,name,specs_json FROM products WHERE tenant_id=? AND deleted_at IS NOT NULL').all(input.tenant_id) as Row[]
    for (const row of archived) {
      let linked: unknown
      try { linked = JSON.parse(row.specs_json || '{}').merged_into_product_id } catch { continue }
      if (typeof linked === 'string' && input.source_ids.includes(linked)) blockers.push('Дубль уже є головною карткою попереднього злиття. Залиште його головним.')
    }
    const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    for (const table of tables) {
      const columns = this.db.prepare('PRAGMA table_info(' + quote(table.name) + ')').all() as { name: string }[]
      for (const column of columns.filter(col => /(^|_)product_id$/.test(col.name))) {
        const rows = this.db.prepare('SELECT * FROM ' + quote(table.name) + ' WHERE ' + quote(column.name) + ' IN (' + placeholders + ') ORDER BY rowid').all(...ids) as Row[]
        if (!rows.length) continue
        if (references[table.name] !== column.name) { blockers.push('Невідоме посилання: ' + table.name); continue }
        if (rows.some(row => row.tenant_id !== input.tenant_id)) blockers.push('Посилання належить іншому магазину: ' + table.name)
        state[table.name] = rows
        if (!(metadata as readonly string[]).includes(table.name)) historyCounts[table.name] = rows.length
      }
    }
    for (const table of metadata) state[table] ??= []
    // Mirror the existing server OEM unique key without rewriting annotations.
    // Distinct raw spellings need review before they could land on one target.
    const crossSpellings = new Map<string, Set<string>>()
    for (const row of (state.product_cross_numbers as Row[]).filter(row => !row.deleted_at)) {
      const raw = String(row.cross_number), key = raw.replace(/[\s\-.\/_]/g, '').toUpperCase()
      const spellings = crossSpellings.get(key) ?? new Set<string>()
      spellings.add(raw); crossSpellings.set(key, spellings)
    }
    if ([...crossSpellings.values()].some(spellings => spellings.size > 1)) blockers.push('Крос-номери мають різне написання одного коду. Звірте аналоги та примітки перед злиттям.')
    const blockQueries: [string, string][] = [
      [`SELECT 1 FROM supply_invoice_items i JOIN supply_invoices d ON d.id=i.invoice_id AND d.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.product_id IN (${placeholders}) AND i.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status='draft' LIMIT 1`, 'Є відкрита накладна'],
      [`SELECT 1 FROM inventory_items i JOIN inventory_sessions d ON d.id=i.session_id AND d.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.product_id IN (${placeholders}) AND i.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status NOT IN ('completed','cancelled','canceled') LIMIT 1`, 'Є відкрита ревізія'],
      [`SELECT 1 FROM stock_reserves WHERE tenant_id=? AND product_id IN (${placeholders}) AND deleted_at IS NULL AND released_at IS NULL LIMIT 1`, 'Є активний резерв'],
      [`SELECT 1 FROM customer_order_items i JOIN customer_orders d ON d.id=i.order_id AND d.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.product_id IN (${placeholders}) AND i.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status NOT IN ('completed','cancelled','canceled','issued','archived') LIMIT 1`, 'Є відкрите замовлення'],
      [`SELECT 1 FROM sale_items i JOIN sales d ON d.id=i.sale_id AND d.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.product_id IN (${placeholders}) AND i.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status IN ('draft','suspended','ready_for_pickup') LIMIT 1`, 'Є відкритий чек'],
    ]
    for (const [sql, message] of blockQueries) if (this.db.prepare(sql).get(input.tenant_id, ...ids)) blockers.push(message)
    if ((state.auto_purchase_rules as Row[] | undefined)?.some(row => input.source_ids.includes(row.product_id) && !row.deleted_at)) blockers.push('У дубля є правило закупівлі. Спочатку звірте правило.')
    if (historyCounts.supplier_price_items) warnings.push('Історичні зв’язки прайсів залишаться на початкових картках; прайси не переписуються.')
    const barcodeRows = state.product_barcodes as Row[]
    const summaries = selected.map(row => ({ ...row, brand: row.brand ?? null,
      additional_barcodes: barcodeRows.filter(code => code.product_id === row.id && !code.deleted_at).map(code => code.barcode).sort(),
      fingerprint: agentFingerprint(row) }))
    // The renderer cannot bypass the same identity rules by sending unrelated IDs.
    // Complete-link validation is bounded to at most 210 pairs, not a full catalog scan.
    for (let left = 0; left < summaries.length; left++) for (let right = left + 1; right < summaries.length; right++) {
      const pair = analyzeCatalogCleanup([summaries[left], summaries[right]]).groups[0]
      if (!pair) blockers.push('Немає достатніх ознак тотожності: ' + summaries[left].name + ' / ' + summaries[right].name)
      else if (pair.level === 'conflict') blockers.push(...pair.conflicts)
      else if (pair.level === 'review') warnings.push('Потрібне підтвердження тотожності: ' + pair.reasons.join('; '))
    }
    const cartState: Row[] = []
    for (const row of this.db.prepare('SELECT key,value_json FROM app_meta ORDER BY key').all() as Row[]) {
      // Completed mutation receipts are immutable history, not live carts. Unknown
      // metadata keys with explicit product references fail closed as well.
      if (/^(mutation:|manual-product-merge:|catalog-cleanup:)/.test(row.key)) continue
      if (!ids.some(id => row.value_json.includes(id)) && !/(cart|open[_-]?receipts?|draft|lan-order-workspace)/i.test(row.key)) continue
      try {
        let value = JSON.parse(row.value_json)
        if (row.key.startsWith('lan-order-workspace:')) value = Array.isArray(value?.drafts)
          ? value.drafts.filter((draft: any) => !Array.isArray(draft.jobs) || draft.jobs.length > 0) : value
        if (containsProduct(value, idsSet)) { blockers.push('Товар є у збереженому кошику або черзі замовлень: ' + row.key); cartState.push(row) }
      }
      catch { blockers.push('Не вдалося перевірити збережений кошик: ' + row.key); cartState.push(row) }
    }
    state.carts = cartState
    const rows = state.product_barcodes as Row[]
    const codes = [...new Set([...selected.map(row => row.barcode), ...rows.filter(row => !row.deleted_at).map(row => row.barcode)].filter(Boolean))] as string[]
    for (const code of codes) {
      const indexOwner = this.db.prepare('SELECT product_id FROM product_barcodes WHERE tenant_id=? AND barcode=?').get(input.tenant_id, code) as Row | undefined
      const otherOwner = this.db.prepare(`SELECT id FROM products WHERE tenant_id=? AND barcode=? AND id NOT IN (${placeholders}) AND deleted_at IS NULL`).get(input.tenant_id, code, ...ids)
      if ((indexOwner && !idsSet.has(indexOwner.product_id)) || otherOwner) blockers.push('Штрихкод належить третій картці: ' + code)
    }
    if (!this.options.canMirrorMerge?.()) blockers.push('Сервер ще не підтвердив підтримку безпечного злиття каталогу')
    if (!this.options.externalBlockers) blockers.push('Відкриті чеки всіх працівників ще не перевірено')
    else blockers.push(...this.options.externalBlockers(ids))
    const quantities = selected.map(row => stockQuantity(Number(row.qty_on_hand)))
    const total = quantities.reduce(addStockQuantity, 0)
    blockers.push(...catalogCleanupManifestBlockers(input, selected, {
      product_barcodes: state.product_barcodes as Row[], product_aliases: state.product_aliases as Row[], product_cross_numbers: state.product_cross_numbers as Row[],
    }, codes, total))
    if (input.stock_review === 'pending') warnings.push('Фактичну наявність не перевірено. Облікову кількість збережено; потрібна окрема ревізія.')
    const preview: CleanupPreview = { fingerprint: hash(state), target_id: input.target_id, source_ids: input.source_ids,
      products: summaries, history_counts: historyCounts,
      blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], quantity_before: quantities, quantity_after: total,
      barcodes: codes.sort(), photos: selected.filter(row => row.photo_url).map(row => ({ product_id: row.id, photo_url: row.photo_url })),
      stock_review: input.stock_review, can_apply: blockers.length === 0 }
    return { preview, state, selected }
  }

  private assertOwner(userId: string, tenantId: string) {
    const user = this.db.prepare('SELECT role,is_active,deleted_at FROM staff_users WHERE id=? AND tenant_id=?').get(userId, tenantId) as Row | undefined
    if (!user || !user.is_active || user.deleted_at || !['owner', 'admin'].includes(user.role)) throw new Error('Очищення каталогу доступне лише власнику або адміністратору')
  }

  apply(input: CleanupApply, userId: string) {
    const normalized = selection(input)
    this.assertOwner(userId, input.tenant_id)
    assertCleanupActorId(userId)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operation_id) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000
      || !/^[a-f0-9]{64}$/.test(input.preview_fingerprint)) throw new Error('Потрібні попередня перевірка, номер операції та причина злиття')
    let verifyWrite: (() => void) | undefined
    return idempotentMutation(this.db, 'catalog-cleanup:' + input.tenant_id, input.operation_id, { ...normalized, preview_fingerprint: input.preview_fingerprint, reason: input.reason, userId }, () => {
      const { preview, state, selected } = this.capture(normalized)
      if (preview.fingerprint !== input.preview_fingerprint) throw new Error('Дані змінилися після перевірки. Оновіть попередній перегляд.')
      if (!preview.can_apply) throw new Error(preview.blockers.join('\n'))
      const timestamp = new Date().toISOString(), target = selected[0], sources = selected.slice(1)
      const oldHistory = Object.fromEntries(Object.entries(state).filter(([key]) => references[key] && !(metadata as readonly string[]).includes(key)))
      const targetSpecs = specs(target)
      targetSpecs.cleanup_sources = [...(Array.isArray(targetSpecs.cleanup_sources) ? targetSpecs.cleanup_sources : []), ...sources.map(row => ({
        id: row.id, sku: row.sku, name: row.name, barcode: row.barcode, brand_id: row.brand_id, category_id: row.category_id, unit: row.unit,
        purchase_price: row.purchase_price, retail_price: row.retail_price, photo_url: row.photo_url, notes: row.notes, storage_bin: row.storage_bin,
        specs: specs(row), merge_operation_id: input.operation_id,
      }))]
      targetSpecs.cleanup_stock_review = { status: input.stock_review, user_id: userId, at: timestamp, operation_id: input.operation_id }
      const sourceBrand = sources.find(row => row.brand_id)?.brand_id ?? null
      const sourceSpecs = new Map(sources.map(row => {
        const saved = specs(row), prior = saved.cleanup_barcodes
        if (prior !== undefined && (!Array.isArray(prior) || prior.some(code => typeof code !== 'string')))
          throw new Error('Пошкоджена історія штрихкодів товару: ' + row.name)
        const current = (state.product_barcodes as Row[]).filter(code => code.product_id === row.id && !code.deleted_at).map(code => code.barcode)
        return [row.id, { ...saved, cleanup_barcodes: [...new Set([...(prior ?? []), row.barcode, ...current].filter(code => typeof code === 'string' && code.length > 0))],
          merged_into_product_id: target.id, merge_operation_id: input.operation_id }]
      }))
      const expectedProducts: Row[] = selected.map(({ brand: _brand, ...row }) => row.id === target.id
        ? { ...row, qty_on_hand: preview.quantity_after, brand_id: row.brand_id ?? sourceBrand,
          specs_json: JSON.stringify(targetSpecs), updated_at: timestamp, dirty_at: timestamp }
        : { ...row, qty_on_hand: 0, is_active: 0, deleted_at: timestamp, updated_at: timestamp, dirty_at: timestamp,
          specs_json: JSON.stringify(sourceSpecs.get(row.id)) })
      this.db.prepare('UPDATE products SET qty_on_hand=?,brand_id=COALESCE(brand_id,?),specs_json=?,updated_at=?,dirty_at=? WHERE id=? AND tenant_id=?')
        .run(preview.quantity_after, sourceBrand, JSON.stringify(targetSpecs), timestamp, timestamp, target.id, input.tenant_id)
      for (const source of sources) {
        this.db.prepare('UPDATE products SET qty_on_hand=0,is_active=0,deleted_at=?,updated_at=?,dirty_at=?,specs_json=? WHERE id=? AND tenant_id=?')
          .run(timestamp, timestamp, timestamp, JSON.stringify(sourceSpecs.get(source.id)), source.id, input.tenant_id)
      }
      for (const code of preview.barcodes) {
        this.db.prepare(`INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,is_primary,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,barcode) DO UPDATE SET product_id=excluded.product_id,is_primary=excluded.is_primary,deleted_at=NULL,updated_at=excluded.updated_at`)
          .run(randomUUID(), input.tenant_id, target.id, code, code === target.barcode ? 1 : 0, timestamp, timestamp)
      }
      for (const source of sources) {
        this.db.prepare('UPDATE product_aliases SET product_id=?,updated_at=? WHERE tenant_id=? AND product_id=?').run(target.id, timestamp, input.tenant_id, source.id)
        for (const alias of [source.name, source.sku].filter(Boolean)) if (!this.db.prepare('SELECT 1 FROM product_aliases WHERE tenant_id=? AND product_id=? AND alias=? AND deleted_at IS NULL').get(input.tenant_id, target.id, alias)) {
          this.db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), input.tenant_id, target.id, alias, timestamp, timestamp)
        }
        for (const cross of (state.product_cross_numbers as Row[]).filter(row => row.product_id === source.id)) {
          // Conflicting annotations remain preserved on the historical card.
          if (!this.db.prepare('SELECT 1 FROM product_cross_numbers WHERE tenant_id=? AND product_id=? AND cross_number=?').get(input.tenant_id, target.id, cross.cross_number))
            this.db.prepare('UPDATE product_cross_numbers SET product_id=?,updated_at=? WHERE tenant_id=? AND id=?').run(target.id, timestamp, input.tenant_id, cross.id)
        }
      }
      expectedProducts[0].search_text = refreshProductSearchText(this.db, target.id, input.tenant_id)
      for (const [table, oldRows] of Object.entries(oldHistory)) {
        const ids = [target.id, ...input.source_ids]
        const after = this.db.prepare('SELECT * FROM ' + quote(table) + ' WHERE ' + quote(references[table]) + ' IN (' + ids.map(() => '?').join(',') + ') ORDER BY rowid').all(...ids)
        if (hash(after) !== hash(oldRows)) throw new Error('Історія документів змінилася. Злиття скасовано.')
      }
      // Historical movement rows remain untouched; only balanced new transfer rows are appended.
      let runningQty = stockQuantity(Number(target.qty_on_hand))
      const newMovements: { id: string; product_id: string; qty_delta: number; qty_after: number }[] = []
      for (const source of sources) {
        const qty = stockQuantity(Number(source.qty_on_hand)); runningQty = addStockQuantity(runningQty, qty)
        for (const [id, delta, after] of [[source.id, -qty, 0], [target.id, qty, runningQty]] as const) {
          const movementId = randomUUID()
          this.db.prepare(`INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,unit_cost,notes,dirty_at,created_at,updated_at)
            VALUES(?,?,?,'product_merge',?,?,?,?,?,?,?,?)`).run(movementId, input.tenant_id, id, input.operation_id + ':' + source.id, delta, after, source.purchase_price,
            'Злиття номенклатури; фізичний залишок не перераховано. ' + input.reason, timestamp, timestamp, timestamp)
          newMovements.push({ id: movementId, product_id: id, qty_delta: delta, qty_after: after })
        }
      }
      const allIds = [target.id, ...normalized.source_ids], placeholders = allIds.map(() => '?').join(',')
      const currentProducts = this.db.prepare(`SELECT * FROM products WHERE tenant_id=? AND id IN (${placeholders}) ORDER BY id`).all(input.tenant_id, ...allIds) as Row[]
      const payload: CleanupMirrorPayload = { version: 1, operation_id: input.operation_id, target_id: target.id, source_ids: normalized.source_ids,
        products: currentProducts.map(row => ({ ...row, specs: specs(row), is_active: Boolean(row.is_active), is_service: Boolean(row.is_service),
          is_favorite: Boolean(row.is_favorite), requires_core_return: Boolean(row.requires_core_return) })),
        barcodes: this.db.prepare(`SELECT * FROM product_barcodes WHERE tenant_id=? AND product_id IN (${placeholders}) ORDER BY id`).all(input.tenant_id, ...allIds) as Row[],
        aliases: this.db.prepare(`SELECT * FROM product_aliases WHERE tenant_id=? AND product_id IN (${placeholders}) ORDER BY id`).all(input.tenant_id, ...allIds) as Row[],
        cross_numbers: this.db.prepare(`SELECT * FROM product_cross_numbers WHERE tenant_id=? AND product_id IN (${placeholders}) ORDER BY id`).all(input.tenant_id, ...allIds) as Row[],
        stock_review: input.stock_review, reason: input.reason.trim(), user_id: userId, merged_at: timestamp }
      const outboxId = randomUUID(), payloadJson = JSON.stringify(payload)
      this.db.prepare(`INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at)
        VALUES(?,?,?,'product',?,'product.catalog_cleanup',?,'pending',?)`).run(outboxId, input.tenant_id, this.db.deviceId, target.id, payloadJson, timestamp)
      const result = { operation_id: input.operation_id, target_id: target.id, source_ids: normalized.source_ids,
        quantity_before: preview.quantity_before, quantity_after: preview.quantity_after, stock_review: input.stock_review, merged_at: timestamp }
      const auditId = randomUUID(), beforeJson = JSON.stringify({ products: selected, metadata: Object.fromEntries(metadata.map(key => [key, state[key]])), history_hash: hash(oldHistory) })
      const afterJson = JSON.stringify({ ...result, reason: input.reason })
      this.db.prepare(`INSERT INTO audit_log(event_id,tenant_id,device_id,user_id,action,entity_type,entity_id,before_json,after_json,created_at)
        VALUES(?,?,?,?,'product.catalog_cleanup','product',?,?,?,?)`).run(auditId, input.tenant_id, this.db.deviceId, userId, target.id, beforeJson, afterJson, timestamp)
      verifyWrite = () => {
        const fail = () => { throw new Error('Не вдалося безпечно зберегти злиття каталогу. Усі зміни цієї спроби скасовано.') }
        for (const expected of expectedProducts) {
          const current = this.db.prepare('SELECT * FROM products WHERE tenant_id=? AND id=?').get(input.tenant_id, expected.id) as Row | undefined
          if (!current || !isDeepStrictEqual({ ...current }, expected)) fail()
        }
        for (const [table, oldRows] of Object.entries(oldHistory)) {
          const after = this.db.prepare('SELECT * FROM ' + quote(table) + ' WHERE ' + quote(references[table]) + ' IN (' + placeholders + ') ORDER BY rowid').all(...allIds) as Row[]
          const historical = table === 'inventory_movements' ? after.filter(row => !newMovements.some(m => m.id === row.id)) : after
          if (hash(historical) !== hash(oldRows)) fail()
        }
        for (const expected of newMovements) {
          const current = this.db.prepare('SELECT id,product_id,qty_delta,qty_after FROM inventory_movements WHERE id=? AND tenant_id=?').get(expected.id, input.tenant_id) as Row | undefined
          if (!current || !isDeepStrictEqual({ ...current }, expected)) fail()
        }
        for (const code of preview.barcodes) {
          const current = this.db.prepare('SELECT product_id,deleted_at FROM product_barcodes WHERE tenant_id=? AND barcode=?').get(input.tenant_id, code) as Row | undefined
          if (current?.product_id !== target.id || current.deleted_at) fail()
        }
        const outbox = this.db.prepare('SELECT payload_json,status FROM sync_outbox WHERE operation_id=? AND tenant_id=?').get(outboxId, input.tenant_id) as Row | undefined
        const audit = this.db.prepare('SELECT before_json,after_json FROM audit_log WHERE event_id=? AND tenant_id=?').get(auditId, input.tenant_id) as Row | undefined
        if (outbox?.payload_json !== payloadJson || outbox.status !== 'pending' || audit?.before_json !== beforeJson || audit.after_json !== afterJson) fail()
      }
      return result
    }, () => { verifyWrite!(); return verifyWrite! })
  }

  applySku(input: { tenant_id: string; operation_id: string; product_id: string; sku: string; preview_fingerprint: string; reason: string }, userId: string) {
    this.assertOwner(userId, input.tenant_id)
    if (input.tenant_id !== DEFAULT_TENANT_ID) throw new Error('Локальний магазин не збігається з профілем')
    if (!/^[0-9a-f-]{36}$/i.test(input.operation_id) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000
      || typeof input.sku !== 'string' || input.sku.length > 80) throw new Error('Перевірте артикул і причину зміни')
    return idempotentMutation(this.db, 'catalog-cleanup-sku:' + input.tenant_id, input.operation_id, { ...input, userId }, () => {
      const row = this.db.prepare('SELECT * FROM products WHERE tenant_id=? AND id=? AND deleted_at IS NULL AND is_active=1').get(input.tenant_id, input.product_id) as Row | undefined
      if (!row || agentFingerprint(row) !== input.preview_fingerprint) throw new Error('Картка змінилася. Оновіть перевірку.')
      if (!missingAgentSku(row.sku) || !catalogCodeFromName(row.name, input.sku)) throw new Error('Артикул можна взяти лише з назви замість порожнього або службового AUTO-')
      const collision = (this.db.prepare('SELECT id,sku,specs_json FROM products WHERE tenant_id=? AND id<>?').all(input.tenant_id, row.id) as Row[])
        .some(other => normalizeAgentCode(other.sku) === normalizeAgentCode(input.sku))
      if (collision) throw new Error('Артикул уже належить іншій картці, зокрема архівній. Перевірте дубль.')
      const result = new CatalogAgentRepository(this.db).apply({ operation_id: input.operation_id, items: [{ product_id: row.id, fingerprint: input.preview_fingerprint, changes: { sku: input.sku } }] }, userId)
      this.db.prepare(`INSERT INTO audit_log(event_id,tenant_id,device_id,user_id,action,entity_type,entity_id,before_json,after_json,created_at)
        VALUES(?,?,?,?,'product.catalog_cleanup_sku','product',?,?,?,?)`).run(randomUUID(), input.tenant_id, this.db.deviceId, userId, row.id,
        JSON.stringify({ sku: row.sku }), JSON.stringify({ sku: input.sku, reason: input.reason, operation_id: input.operation_id }), new Date().toISOString())
      return result
    })
  }
}
