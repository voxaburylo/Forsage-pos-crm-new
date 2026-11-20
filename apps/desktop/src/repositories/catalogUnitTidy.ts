import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { LocalCatalogRepository } from './catalogRepository'
import { tidyUnit } from './supplyValidation'

/**
 * 20.11.2026, рішення власника «просто наведи порядок»: у картках було 19 написань одиниць
 * («ШТ», «шт.», «Штука», «од.», «К-Т», «ком-т», «Комплект», «Пара», «уп», «упаков»…).
 * При запуску програма зводить їх до шт/компл/л/м/кг/мл/упак звичайним збереженням картки
 * (зміна йде й на сервер). Кількість, ціни й незнайомі одиниці не змінюються.
 */
export function tidyUnitSpellings(db: LocalDatabase): number {
  const catalog = new LocalCatalogRepository(db)
  const rows = db.readSnapshot(() => db.prepare(`SELECT id,tenant_id,sku,name,unit FROM products
    WHERE deleted_at IS NULL ORDER BY tenant_id,id`).all() as Array<{ id: string; tenant_id: string; sku: string; name: string; unit: string | null }>)
  let changed = 0
  for (const row of rows) {
    const to = tidyUnit(row.unit)
    if (!to || to === row.unit) continue
    db.transaction(() => {
      catalog.saveProduct({ id: row.id, tenant_id: row.tenant_id, sku: row.sku, name: row.name, unit: to })
      db.prepare(`INSERT INTO audit_log(event_id,tenant_id,device_id,user_id,action,entity_type,entity_id,before_json,after_json,created_at)
        VALUES(?,?,?,NULL,'catalog.unit_tidy','product',?,?,?,?)`).run(randomUUID(), row.tenant_id, db.deviceId, row.id,
        JSON.stringify({ unit: row.unit }), JSON.stringify({ unit: to }), new Date().toISOString())
    })
    changed++
  }
  return changed
}

/** Скільки карток чекають на однакове написання одиниці — щоб резервна копія робилась лише за потреби. */
export function pendingUnitSpellings(db: LocalDatabase): number {
  const rows = db.prepare('SELECT DISTINCT unit FROM products WHERE deleted_at IS NULL').all() as Array<{ unit: string | null }>
  return rows.filter(row => { const to = tidyUnit(row.unit); return !!to && to !== row.unit }).length
}
