import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { LocalCatalogRepository } from './catalogRepository'
import { readProductCatalogSnapshot } from './productCatalogSnapshot'

/**
 * 22.11.2026, рішення власника «Вернуть»: до виправлення e91d222 нова основна картка штрихкоду стирала попередній
 * (17.11 проведення накладної так забрало коди 81 картки, усього 116 кодів — docs/LOST_BARCODES_2026-11-22.md).
 * Один раз при запуску програма повертає такі коди карткам як додаткові — звичайним збереженням картки
 * (зміна йде й на сервер, запис у журналі дій). Беремо лише коди, стерті до виправлення, якщо картка жива
 * й код ніде більше не використовується. Залишки, ціни й основний код не змінюються.
 */
// Список власник погодив 22.11 (116 кодів, стерті з 10.09 по 21.11); те, що стерто пізніше, — вже свідома дія.
export const ERASED_BARCODES_CUTOFF = '2026-11-22T00:00:00.000Z'

type ErasedRow = { tenant_id: string; product_id: string; barcode: string }

function erasedBarcodes(db: LocalDatabase): ErasedRow[] {
  return db.prepare(`
    SELECT b.tenant_id, b.product_id, b.barcode
    FROM product_barcodes b
    JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
    WHERE b.deleted_at IS NOT NULL AND b.deleted_at < ? AND p.deleted_at IS NULL
      AND TRIM(b.barcode) <> ''
      AND NOT EXISTS (SELECT 1 FROM product_barcodes x WHERE x.tenant_id = b.tenant_id AND x.barcode = b.barcode AND x.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM products y WHERE y.tenant_id = b.tenant_id AND y.barcode = b.barcode AND y.deleted_at IS NULL)
    GROUP BY b.tenant_id, b.product_id, b.barcode
    ORDER BY b.tenant_id, b.product_id, b.barcode
  `).all(ERASED_BARCODES_CUTOFF) as ErasedRow[]
}

/** Скільки стертих кодів чекають повернення — щоб резервна копія робилась лише за потреби. */
export function pendingErasedBarcodes(db: LocalDatabase): number {
  return erasedBarcodes(db).length
}

export function restoreErasedBarcodes(db: LocalDatabase): { restored: number; skipped: number } {
  const catalog = new LocalCatalogRepository(db)
  const byProduct = new Map<string, ErasedRow[]>()
  for (const row of db.readSnapshot(() => erasedBarcodes(db))) {
    const key = row.tenant_id + '\0' + row.product_id
    byProduct.set(key, [...(byProduct.get(key) ?? []), row])
  }
  let restored = 0, skipped = 0
  for (const rows of byProduct.values()) {
    const { tenant_id: tenantId, product_id: productId } = rows[0]
    try {
      db.transaction(() => {
        const snapshot = readProductCatalogSnapshot(db, productId, tenantId) as { sku: string; name: string; additional_barcodes?: string[] }
        const before = snapshot.additional_barcodes ?? []
        const after = [...new Set([...before, ...rows.map(row => row.barcode)])]
        catalog.saveProduct({ id: productId, tenant_id: tenantId, sku: snapshot.sku, name: snapshot.name, additional_barcodes: after })
        db.prepare(`INSERT INTO audit_log(event_id,tenant_id,device_id,user_id,action,entity_type,entity_id,before_json,after_json,created_at)
          VALUES(?,?,?,NULL,'catalog.barcode_restore','product',?,?,?,?)`).run(randomUUID(), tenantId, db.deviceId, productId,
          JSON.stringify({ additional_barcodes: before }), JSON.stringify({ additional_barcodes: after }), new Date().toISOString())
      })
      restored += rows.length
    } catch {
      // Код міг уже з'явитись в іншої картки — таку картку пропускаємо, решта повертається.
      skipped += rows.length
    }
  }
  return { restored, skipped }
}
