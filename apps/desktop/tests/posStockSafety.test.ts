import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('local POS stock safety', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let pos: LocalPosRepository
  let cashierId = ''
  let shiftId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-pos-stock-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    pos = new LocalPosRepository(db)
    cashierId = randomUUID()
    shiftId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, cashierId, now, now, now)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-pos-stock-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function product(qty: number) {
    return catalog.upsertProduct({
      id: randomUUID(), sku: `POS-${randomUUID()}`, name: 'Контрольований товар',
      qty_on_hand: qty, purchase_price: 50, retail_price: 100,
    })
  }

  it('rejects a cumulative sale above available stock by default', () => {
    const stored = product(1)
    expect(() => pos.checkout({
      cashier_id: cashierId,
      shift_id: shiftId,
      items: [
        { product_id: stored.id, qty: 0.6, unit_price: 100 },
        { product_id: stored.id, qty: 0.6, unit_price: 100 },
      ],
      payments: [{ method: 'cash', amount: 120 }],
    })).toThrow(/Недостатньо товару/)
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(1)
  })

  it('does not sell stock reserved for an order', () => {
    const stored = product(2)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO stock_reserves (id, tenant_id, product_id, qty, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(randomUUID(), DEFAULT_TENANT_ID, stored.id, now, now)

    expect(() => pos.checkout({
      cashier_id: cashierId,
      shift_id: shiftId,
      items: [{ product_id: stored.id, qty: 2, unit_price: 100 }],
      payments: [{ method: 'cash', amount: 200 }],
    })).toThrow(/Доступно: 1/)
  })

  it('allows negative stock only when the setting is explicitly enabled', () => {
    const stored = product(1)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO app_meta(key, value_json, updated_at) VALUES ('shop_settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify({ allow_negative_qty: true }), now)

    pos.checkout({
      cashier_id: cashierId,
      shift_id: shiftId,
      items: [{ product_id: stored.id, qty: 2, unit_price: 100 }],
      payments: [{ method: 'cash', amount: 200 }],
    })
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(-1)
  })
})