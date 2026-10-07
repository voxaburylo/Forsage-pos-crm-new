import { createHash, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { addStockQuantity, stockQuantity } from './stockQuantity'
import { checkedAiSupplyUnit } from './supplyValidation'

type MergeDatabase = Pick<LocalDatabase, 'prepare' | 'transaction' | 'deviceId'>
type Row = Record<string, any>
export interface ManualProductMerge {
  operation_id: string; tenant_id: string; source_id: string; target_id: string
  source_fingerprint: string; target_fingerprint: string; reason: string
}
export const mergeProductFingerprint = (row: Row) => createHash('sha256').update(JSON.stringify(row)).digest('hex')
const references: Record<string, string> = {
  sale_items: 'product_id', supply_invoice_items: 'product_id', customer_return_items: 'product_id',
  warehouse_movements: 'product_id', stock_reserves: 'product_id', writeoff_items: 'product_id',
  customer_order_items: 'product_id', supplier_price_items: 'matched_product_id', auto_purchase_rules: 'product_id',
}
const preserved = ['inventory_movements', 'inventory_items', 'inventory_count_entries']
const metadata = ['product_barcodes', 'product_aliases', 'product_cross_numbers']
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"'
const json = (value: string) => { const data = JSON.parse(value || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Некоректні метадані товару'); return data }

/**
 * Maintenance-only, explicit reviewed pairs. No fuzzy discovery and no IPC endpoint.
 * Keeps original counts/movements on their historical card. Document-bearing
 * sources are blocked until a mirrored history transition exists; unused-card
 * merges record a balanced stock transfer without inferring a physical recount.
 * A physical recount is a SEPARATE inventory document, never inferred here.
 */
export function mergeProductsManually(db: MergeDatabase, input: ManualProductMerge): any {
  if (!input.reason.trim() || !input.operation_id || input.source_id === input.target_id) throw new Error('Потрібна перевірена пара й причина об’єднання')
  return db.transaction(() => {
    const key = 'manual-product-merge:' + input.tenant_id + ':' + input.operation_id
    const request = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const prior = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as { value_json: string } | undefined
    if (prior) {
      const saved = JSON.parse(prior.value_json)
      if (saved.request !== request) throw new Error('Ідентифікатор об’єднання вже використано з іншими даними')
      return saved.result
    }
    const product = (id: string) => db.prepare('SELECT * FROM products WHERE tenant_id=? AND id=?').get(input.tenant_id, id) as Row | undefined
    const source = product(input.source_id), target = product(input.target_id)
    if (!source || !target || source.deleted_at || target.deleted_at || !source.is_active || !target.is_active || source.is_service || target.is_service) throw new Error('Обидві картки мають бути активними товарами')
    if (mergeProductFingerprint(source) !== input.source_fingerprint || mergeProductFingerprint(target) !== input.target_fingerprint) throw new Error('Картки змінилися після перевірки — злиття зупинено')
    if (json(source.specs_json).merged_into_product_id || json(target.specs_json).merged_into_product_id) throw new Error('Не можна повторно використати об’єднану картку')
    checkedAiSupplyUnit(source.unit, target.unit, 'Об’єднання')
    if (source.brand_id && target.brand_id && source.brand_id !== target.brand_id) throw new Error('Різні бренди — потрібна окрема перевірка')
    if (source.requires_core_return !== target.requires_core_return || source.core_deposit_amount !== target.core_deposit_amount) throw new Error('Різні заставні умови')
    const sourceQty = stockQuantity(Number(source.qty_on_hand)), targetQty = stockQuantity(Number(target.qty_on_hand))
    if (sourceQty < 0 || targetQty < 0) throw new Error('Від’ємні залишки потрібно звірити окремо')
    const quantity = addStockQuantity(sourceQty, targetQty)
    const args = [input.tenant_id, source.id, target.id]
    const blocks = [
      [`SELECT 1 FROM supply_invoice_items i JOIN supply_invoices s ON s.id=i.invoice_id AND s.tenant_id=i.tenant_id
        WHERE i.tenant_id=? AND i.product_id IN (?,?) AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status='draft' LIMIT 1`, 'Є відкрита накладна'],
      [`SELECT 1 FROM inventory_items i JOIN inventory_sessions s ON s.id=i.session_id AND s.tenant_id=i.tenant_id
        WHERE i.tenant_id=? AND i.product_id IN (?,?) AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status NOT IN ('completed','cancelled') LIMIT 1`, 'Є відкрита ревізія'],
      [`SELECT 1 FROM stock_reserves WHERE tenant_id=? AND product_id IN (?,?) AND deleted_at IS NULL AND released_at IS NULL LIMIT 1`, 'Є резерв товару'],
      [`SELECT 1 FROM customer_order_items i JOIN customer_orders o ON o.id=i.order_id AND o.tenant_id=i.tenant_id
        WHERE i.tenant_id=? AND i.product_id IN (?,?) AND i.deleted_at IS NULL AND o.deleted_at IS NULL AND o.status NOT IN ('completed','cancelled','issued') LIMIT 1`, 'Є відкрите замовлення'],
    ]
    for (const [sql, message] of blocks) if (db.prepare(sql).get(...args)) throw new Error(message + ' — спочатку завершіть документ')
    const rules = db.prepare('SELECT product_id FROM auto_purchase_rules WHERE tenant_id=? AND product_id IN (?,?) AND deleted_at IS NULL').all(...args)
    if (rules.length > 1) throw new Error('Є два правила закупівлі — їх потрібно звірити')
    // Fail closed when a future schema adds an unhandled product reference.
    for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>) {
      for (const col of db.prepare('PRAGMA table_info(' + quote(table.name) + ')').all() as Array<{name:string}>) {
        if (!/(^|_)product_id$/.test(col.name)) continue
        if (references[table.name] === col.name || [...preserved, ...metadata].includes(table.name)) continue
        if (db.prepare('SELECT 1 FROM ' + quote(table.name) + ' WHERE ' + quote(col.name) + '=? LIMIT 1').get(source.id)) throw new Error('Невідоме посилання: ' + table.name)
      }
    }
    // Financial/history rewrites need a mirrored merge event and new document
    // checkpoints. Product upsert+delete alone cannot preserve those identities.
    for (const table of ['sale_items', 'supply_invoice_items', 'customer_return_items',
      'warehouse_movements', 'stock_reserves', 'writeoff_items', 'customer_order_items']) {
      if (db.prepare('SELECT 1 FROM ' + table + ' WHERE product_id=? LIMIT 1').get(source.id))
        throw new Error('До дубліката прив’язана історія документів. Потрібна окрема звірка; залишки не змінено.')
    }
    for (const table of [...metadata, ...preserved, 'supplier_price_items', 'auto_purchase_rules']) {
      const column = references[table] ?? 'product_id'
      if (db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + column + '=? AND tenant_id<>? LIMIT 1').get(source.id, input.tenant_id))
        throw new Error('Посилання на товар належить іншому магазину. Потрібна звірка.')
    }
    const before: Record<string, unknown> = { source, target }
    for (const [table, column] of Object.entries(references)) before[table] = db.prepare('SELECT * FROM ' + table + ' WHERE tenant_id=? AND ' + column + '=? ORDER BY id').all(input.tenant_id, source.id)
    for (const table of [...metadata, ...preserved]) before[table] = db.prepare('SELECT * FROM ' + table + ' WHERE tenant_id=? AND product_id=? ORDER BY id').all(input.tenant_id, source.id)
    const timestamp = new Date().toISOString()
    const codes = new Set<string>([source.barcode, ...(before.product_barcodes as Row[]).filter(b => !b.deleted_at).map(b => b.barcode)].filter(Boolean))
    for (const barcode of codes) {
      const owner = db.prepare('SELECT product_id FROM product_barcodes WHERE tenant_id=? AND barcode=?').get(input.tenant_id, barcode) as Row | undefined
      if (owner && ![source.id, target.id].includes(owner.product_id)) throw new Error('Штрихкод зайнятий третьою карткою: ' + barcode)
      const third = db.prepare('SELECT id FROM products WHERE tenant_id=? AND barcode=? AND id NOT IN (?,?) AND deleted_at IS NULL').get(input.tenant_id, barcode, source.id, target.id)
      if (third) throw new Error('Штрихкод використано третьою активною карткою')
      db.prepare(`INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,is_primary,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,barcode) DO UPDATE SET product_id=excluded.product_id,is_primary=excluded.is_primary,deleted_at=NULL,updated_at=excluded.updated_at`)
        .run(randomUUID(), input.tenant_id, target.id, barcode, barcode === target.barcode ? 1 : 0, timestamp, timestamp)
    }
    for (const [table, column] of Object.entries(references)) {
      const cols = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as Row[]).map(c => c.name))
      const updates = [column + '=?'], values: any[] = [target.id]
      if (cols.has('updated_at')) { updates.push('updated_at=?'); values.push(timestamp) }
      if (cols.has('dirty_at')) { updates.push('dirty_at=?'); values.push(timestamp) }
      db.prepare('UPDATE ' + table + ' SET ' + updates.join(',') + ' WHERE tenant_id=? AND ' + column + '=?').run(...values, input.tenant_id, source.id)
    }
    db.prepare('UPDATE product_aliases SET product_id=?,updated_at=? WHERE tenant_id=? AND product_id=?').run(target.id, timestamp, input.tenant_id, source.id)
    for (const alias of [source.name, source.sku]) {
      if (!db.prepare('SELECT 1 FROM product_aliases WHERE tenant_id=? AND product_id=? AND alias=? AND deleted_at IS NULL').get(input.tenant_id, target.id, alias)) {
        db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), input.tenant_id, target.id, alias, timestamp, timestamp)
      }
    }
    for (const row of before.product_cross_numbers as Row[]) {
      const existing = db.prepare('SELECT id FROM product_cross_numbers WHERE tenant_id=? AND product_id=? AND cross_number=?').get(input.tenant_id, target.id, row.cross_number)
      if (!existing) db.prepare('UPDATE product_cross_numbers SET product_id=?,updated_at=? WHERE id=?').run(target.id, timestamp, row.id)
      // Do not silently discard notes/source on colliding cross-numbers; retain them on the tombstone.
    }
    const specs = { ...json(source.specs_json), merged_into_product_id: target.id, merge_operation_id: input.operation_id }
    db.prepare('UPDATE products SET qty_on_hand=0,is_active=0,deleted_at=?,updated_at=?,dirty_at=?,specs_json=? WHERE tenant_id=? AND id=?')
      .run(timestamp, timestamp, timestamp, JSON.stringify(specs), input.tenant_id, source.id)
    db.prepare('UPDATE products SET qty_on_hand=?,brand_id=COALESCE(brand_id,?),updated_at=?,dirty_at=? WHERE tenant_id=? AND id=?')
      .run(quantity, source.brand_id, timestamp, timestamp, input.tenant_id, target.id)
    // Use existing mirror operations. The local signed balance snapshot remains authoritative.
    const current = product(target.id)!
    const additionalBarcodes = (db.prepare('SELECT barcode FROM product_barcodes WHERE tenant_id=? AND product_id=? AND deleted_at IS NULL AND is_primary=0').all(input.tenant_id,target.id) as Row[]).map(row => row.barcode)
    const primaryPayload = { ...current, specs: json(current.specs_json), additional_barcodes: additionalBarcodes,
      is_active: Boolean(current.is_active), is_service: Boolean(current.is_service), is_favorite: Boolean(current.is_favorite),
      requires_core_return: Boolean(current.requires_core_return) }
    for (const [id,type,payload] of [[target.id,'product.upsert',primaryPayload],[source.id,'product.deleted',{id:source.id,tenant_id:input.tenant_id}]]) {
      db.prepare(`INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at)
        VALUES(?,?,?,'product',?,?,?,'pending',?)`).run(randomUUID(),input.tenant_id,db.deviceId,id,type,JSON.stringify(payload),timestamp)
    }
    const movementIds: string[] = []
    for (const [id,delta,after] of [[source.id,-sourceQty,0],[target.id,sourceQty,quantity]]) {
      const movementId = randomUUID(); movementIds.push(movementId)
      db.prepare(`INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,unit_cost,notes,dirty_at,created_at,updated_at)
        VALUES(?,?,?,'product_merge',?,?,?,?,?,?,?,?)`).run(movementId, input.tenant_id, id, input.operation_id, delta, after, source.purchase_price,
        'Об’єднання карток ' + source.sku + ' → ' + target.sku + '. Кількість збережено, фізичний залишок не перераховано. ' + input.reason, timestamp, timestamp, timestamp)
    }
    const result = { source_id: source.id, target_id: target.id, quantity_before: [targetQty,sourceQty], quantity_after: quantity, movement_ids: movementIds, merged_at: timestamp }
    db.prepare(`INSERT INTO audit_log(event_id,tenant_id,device_id,action,entity_type,entity_id,before_json,after_json,created_at)
      VALUES(?,?,?,'product.manual_merge','product',?,?,?,?)`).run(randomUUID(), input.tenant_id, db.deviceId, target.id, JSON.stringify(before), JSON.stringify({ ...result, reason: input.reason }), timestamp)
    db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run(key, JSON.stringify({ request, result }), timestamp)
    return result
  })
}
