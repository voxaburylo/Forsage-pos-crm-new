import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalPurchaseRepository } from '../src/repositories/localPurchaseRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

// 24.11.2026 (слово власника): в «Автозакупівлі» — товари з низьким залишком за постачальниками, для листа замовлення.
describe('restock needs: what runs low, by the supplier it last came from', () => {
  let root: string, db: LocalDatabase, repo: LocalPurchaseRepository, shift: string
  const now = new Date('2026-11-24T12:00:00Z')
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
  const T = DEFAULT_TENANT_ID
  let n = 0
  const product = (id: string, qty: number, over: Record<string, number> = {}) =>
    db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,purchase_price,reorder_point,is_service,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, T, 'SKU-' + id, 'Товар ' + id, qty, 10000, over.reorder_point ?? 0, over.is_service ?? 0, over.is_active ?? 1, ago(200), ago(200))
  const sale = (productId: string, qty: number, days: number, status = 'completed') => {
    const id = 'sale-' + ++n
    db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at) VALUES(?,?,?,'cashier',?,?,0,'cash',?,?,?)").run(id, T, 'N-' + n, shift, status, ago(days), ago(days), ago(days))
    db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,description,qty,unit_price,total,created_at,updated_at) VALUES(?,?,?,?,'x',?,0,0,?,?)").run('line-' + n, T, id, productId, qty, ago(days), ago(days))
  }
  const supplier = (id: string, name: string) => db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, T, name, ago(300), ago(300))
  const invoice = (supplierId: string, productId: string, days: number, status = 'posted') => {
    const id = 'inv-' + ++n
    db.prepare('INSERT INTO supply_invoices(id,tenant_id,supplier_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, T, supplierId, status, ago(days), ago(days))
    db.prepare('INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,total,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?)').run('ii-' + n, T, id, productId, ago(days), ago(days))
  }
  const needs = () => Object.fromEntries(repo.restockNeeds(T, now).map(row => [row.product_id, row]))

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-restock-'))
    db = new LocalDatabase(root); repo = new LocalPurchaseRepository(db); n = 0
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('cashier', T, 'Олексій', 'cashier', ago(300), ago(300))
    shift = new LocalPosRepository(db).openShift({ cashier_id: 'cashier', opening_cash: 0 })
    supplier('vitol', 'Vitol'); supplier('omega', 'Омега')
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-restock-')) rmSync(root, { recursive: true, force: true })
  })

  it('takes goods that sold in 90 days and have less stock than a month of sales; suggests topping up to a month', () => {
    product('low', 2); sale('low', 3, 5); sale('low', 4, 20); sale('low', 5, 60)
    product('enough', 10); sale('enough', 3, 5)
    product('gone', 0); sale('gone', 1, 70)
    product('dead', 0); sale('dead', 9, 120)
    product('refunded', 0); sale('refunded', 2, 3, 'voided')
    const got = needs()
    expect(Object.keys(got).sort()).toEqual(['gone', 'low'])
    expect([got.low.sold_30, got.low.sold_90, got.low.qty_on_hand, got.low.suggest_qty]).toEqual([7, 12, 2, 5])
    expect([got.gone.sold_30, got.gone.suggest_qty]).toEqual([0, 1])
  })

  it('the supplier is the one the goods last came from by a posted invoice; unknown stays empty', () => {
    product('a', 0); sale('a', 2, 3); invoice('vitol', 'a', 50); invoice('omega', 'a', 10); invoice('vitol', 'a', 1, 'draft')
    product('b', 0); sale('b', 2, 3)
    const got = needs()
    expect([got.a.supplier_id, got.a.supplier_name]).toEqual(['omega', 'Омега'])
    expect([got.b.supplier_id, got.b.supplier_name]).toEqual([null, null])
  })

  it('a minimum in the card also counts; services, switched-off cards and a negative stock do not break it', () => {
    product('min', 3, { reorder_point: 4 })
    product('service', 0, { is_service: 1 }); sale('service', 5, 2)
    product('off', 0, { is_active: 0 }); sale('off', 5, 2)
    product('minus', -2); sale('minus', 3, 2)
    const got = needs()
    expect(Object.keys(got).sort()).toEqual(['min', 'minus'])
    expect(got.min.suggest_qty).toBe(5)
    expect([got.minus.qty_on_hand, got.minus.suggest_qty]).toEqual([-2, 3])
  })

  it('only reads: nothing is queued for the server and stock stays as it was', () => {
    product('low', 1); sale('low', 3, 5)
    const before = db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get()
    repo.restockNeeds(T, now)
    expect(db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get()).toEqual(before)
    expect(db.prepare("SELECT qty_on_hand FROM products WHERE id = 'low'").get()).toEqual({ qty_on_hand: 1 })
  })
})
