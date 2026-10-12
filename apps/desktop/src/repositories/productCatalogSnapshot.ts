import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import type { LocalProductUpsert } from '../db/localTypes'

/** A replacement outbox version must contain the complete saved card, not just
 * the fields touched by the last editor. Read inside the caller's transaction. */
export function readProductCatalogSnapshot(db: LocalDatabase, id: string, tenant: string): LocalProductUpsert {
  const row = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=? AND deleted_at IS NULL')
    .get(id, tenant) as Record<string, any> | undefined
  if (!row) throw new Error('Товар для копії каталогу не знайдено; зміни не збережено.')
  const codes = db.prepare(`SELECT barcode FROM product_barcodes
    WHERE tenant_id=? AND product_id=? AND deleted_at IS NULL AND is_primary=0 ORDER BY barcode`)
    .all(tenant, id) as Array<{ barcode: string }>
  const crosses = db.prepare(`SELECT cross_number FROM product_cross_numbers
    WHERE tenant_id=? AND product_id=? AND deleted_at IS NULL ORDER BY cross_number`)
    .all(tenant, id) as Array<{ cross_number: string }>
  return {
    id, tenant_id: tenant, sku: row.sku, name: row.name, barcode: row.barcode,
    brand_id: row.brand_id, category_id: row.category_id, unit: row.unit,
    purchase_price: row.purchase_price, retail_price: row.retail_price, qty_on_hand: row.qty_on_hand,
    reorder_point: row.reorder_point, notes: row.notes, storage_bin: row.storage_bin,
    photo_url: row.photo_url, core_deposit_amount: row.core_deposit_amount,
    is_active: row.is_active === 1, is_service: row.is_service === 1,
    is_favorite: row.is_favorite === 1, requires_core_return: row.requires_core_return === 1,
    specs: JSON.parse(row.specs_json || '{}'), additional_barcodes: codes.map(code => code.barcode),
    cross_numbers: crosses.map(code => code.cross_number),
  }
}

/** Queue the already committed-in-transaction catalog state. No business row,
 * stock delta, timestamp or earlier delivery attempt is rewritten here. */
export function queueProductCatalogSnapshot(db: LocalDatabase, id: string, tenant: string, timestamp: string) {
  const event = {
    operation_id: randomUUID(), tenant_id: tenant, device_id: db.deviceId,
    aggregate_type: 'product', aggregate_id: id, operation_type: 'product.upsert',
    payload_json: JSON.stringify(readProductCatalogSnapshot(db, id, tenant)),
    status: 'pending', attempts: 0, next_attempt_at: null, created_at: timestamp,
    synced_at: null, last_error: null,
  }
  const inserted = db.prepare(`INSERT INTO sync_outbox
    (operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at)
    VALUES(?,?,?,'product',?,'product.upsert',?,'pending',?)`)
    .run(event.operation_id, tenant, db.deviceId, id, event.payload_json, timestamp)
  const expected = { sequence: Number(inserted.lastInsertRowid), ...event }
  const actual = db.prepare('SELECT * FROM sync_outbox WHERE operation_id=?').get(event.operation_id)
  if (inserted.changes !== 1 || !Number.isSafeInteger(expected.sequence) || expected.sequence <= 0
    || !actual || !isDeepStrictEqual({ ...actual }, expected))
    throw new Error('Копію ціни товару не збережено; проведення накладної скасовано.')
  return expected
}
