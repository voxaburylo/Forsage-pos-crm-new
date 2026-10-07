import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { attachBalanceSnapshots } from '../src/repositories/balanceSnapshot'

describe('return document outbox preserves the exact local decision', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository
  let cashier: string, customer: string, product: string, shift: string, sale: string, line: string
  const created = '2026-10-03T10:00:00.000Z'
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(created))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-return-copy-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    cashier = randomUUID(); customer = randomUUID()
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(cashier, tenant, 'Касир для тесту', 'cashier', created, created)
    db.prepare('INSERT INTO customers(id,tenant_id,phone,full_name,deposit_balance,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(customer, tenant, randomUUID(), 'Тестовий клієнт', 5000, created, created)
    shift = pos.openShift({ cashier_id: cashier, opening_cash: 100000 })
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Тест',
      qty_on_hand: 10, purchase_price: 5000, retail_price: 10000 }).id
    sale = pos.checkout({ cashier_id: cashier, shift_id: shift, customer_id: customer, discount: 2000,
      items: [{ product_id: product, qty: 2, unit_price: 10000 }], payments: [{ method: 'cash', amount: 18000 }] }).sale_id
    line = pos.getSaleForReturn(sale).items[0].id
  })
  afterEach(() => {
    db.close(); vi.useRealTimers()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-return-copy-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function returnCopy(method = 'credit') {
    const returned = pos.createReturn({ sale_id: sale, approved_by: cashier, shift_id: shift,
      refund_method: method, reason: 'other', stock_action: 'return_to_stock', client_operation_id: randomUUID(),
      items: [{ sale_item_id: line, product_id: product, quantity: 1 }] })
    const row = db.prepare("SELECT * FROM sync_outbox WHERE aggregate_id=? AND operation_type='return.created'").get(returned.id) as any
    return { ...row, payload: JSON.parse(row.payload_json) }
  }
  function legacyCopy() {
    const copy = returnCopy()
    delete copy.payload.approved_by; delete copy.payload.created_at; delete copy.payload.deposit_transaction
    return copy
  }
  it('new returns include the original actor, receipt discount and credit transaction identity', () => {
    const copy = returnCopy(), transaction = db.prepare('SELECT * FROM customer_deposit_transactions WHERE sale_id=?').get(sale) as any
    expect(copy.payload).toMatchObject({ approved_by: cashier, created_at: created, refund_kopecks: 9000,
      shift_id:shift,shift_link_recorded:true,deposit_transaction: { id: transaction.id, balance_after: 14000 } })
    expect(copy.payload.items[0]).toMatchObject({ sale_item_id: line, quantity: 1, unit_price: 10000, total: 9000 })
  })
  it.each(['cash', 'terminal'])('%s return has no invented deposit transaction', method => {
    const copy = returnCopy(method)
    expect(copy.payload.approved_by).toBe(cashier)
    expect(copy.payload.deposit_transaction).toBeUndefined()
    if (method === 'cash') expect(db.prepare('SELECT amount FROM cash_operations WHERE id=?').get(copy.aggregate_id)).toMatchObject({ amount: 9000 })
  })
  it('enriches missing legacy metadata with read-only local queries, even after the account was spent', () => {
    const copy = legacyCopy()
    db.prepare('UPDATE customers SET deposit_balance=1 WHERE id=?').run(customer)
    const before = db.prepare('SELECT * FROM customer_deposit_transactions').all()
    db.exec('PRAGMA query_only=ON')
    try {
      const result = attachBalanceSnapshots(db, [copy])[0]
      expect(result.payload).toMatchObject({ approved_by: cashier, created_at: created,
        deposit_transaction: { id: (before[0] as any).id, balance_after: 14000 } })
      expect(result.payload.local_balance_snapshot.customers[0].deposit_balance).toBe(1)
      expect(copy.payload.deposit_transaction).toBeUndefined()
      expect(db.prepare('SELECT * FROM customer_deposit_transactions').all()).toEqual(before)
    } finally { db.exec('PRAGMA query_only=OFF') }
  })
  it('does not guess which of two historical credit records belongs to the return', () => {
    const copy = legacyCopy(), row = db.prepare('SELECT * FROM customer_deposit_transactions WHERE sale_id=?').get(sale) as any
    db.prepare(`INSERT INTO customer_deposit_transactions(id,tenant_id,customer_id,amount,balance_after,method,sale_id,shift_id,created_at,updated_at)
      VALUES(?,?,?,?,?,'return_credit',?,?,?,?)`).run(randomUUID(), tenant, customer, row.amount, row.balance_after, sale, shift, created, created)
    const other = { ...copy, operation_type: 'product.updated', aggregate_type: 'product', aggregate_id: product, payload: { id: product } }
    const results = attachBalanceSnapshots(db, [copy, other])
    expect(results[0].payload.deposit_transaction).toBeUndefined()
    expect(results[1].payload.local_balance_snapshot.products).toHaveLength(1)
  })
  it.each(['different tenant', 'different amount', 'deleted transaction'])('does not enrich from %s', scenario => {
    const copy = legacyCopy()
    if (scenario === 'different tenant') copy.tenant_id = randomUUID()
    if (scenario === 'different amount') copy.payload.refund_kopecks++
    if (scenario === 'deleted transaction') db.prepare('UPDATE customer_deposit_transactions SET deleted_at=?').run(created)
    expect(attachBalanceSnapshots(db, [copy])[0].payload.deposit_transaction).toBeUndefined()
  })

  it('recovers a missing shift from the exact local document without changing the queue', () => {
    const copy=returnCopy('terminal');delete copy.payload.shift_id;delete copy.payload.shift_link_recorded
    const before=db.prepare('SELECT payload_json FROM sync_outbox WHERE operation_id=?').get(copy.operation_id)
    const enriched=attachBalanceSnapshots(db,[copy])[0].payload
    expect(enriched).toMatchObject({shift_id:shift,shift_link_recorded:true})
    expect(db.prepare('SELECT payload_json FROM sync_outbox WHERE operation_id=?').get(copy.operation_id)).toEqual(before)
    expect(copy.payload.shift_id).toBeUndefined()
  })
  it('does not infer an absent legacy shift from the original receipt', () => {
    const copy=returnCopy('terminal');delete copy.payload.shift_id;delete copy.payload.shift_link_recorded
    db.prepare('UPDATE customer_returns SET shift_id=NULL WHERE id=?').run(copy.aggregate_id)
    const enriched=attachBalanceSnapshots(db,[copy])[0].payload
    expect(enriched).toMatchObject({shift_id:null,shift_link_recorded:false})
    expect(db.prepare('SELECT shift_id FROM sales WHERE id=?').get(sale)).toMatchObject({shift_id:shift})
  })
  it('marks a newly created non-cash return outside a shift explicitly, even after restart', () => {
    pos.closeShift(cashier,pos.getExpectedCash(cashier)!.expected_amount,null,shift)
    const returned=pos.createReturn({sale_id:sale,approved_by:cashier,refund_method:'terminal',stock_action:'return_to_stock',
      client_operation_id:randomUUID(),items:[{sale_item_id:line,product_id:product,quantity:1}]})
    db.close();db=new LocalDatabase(root);pos=new LocalPosRepository(db)
    const row=db.prepare("SELECT * FROM sync_outbox WHERE aggregate_id=? AND operation_type='return.created'").get(returned.id) as any
    const copy={...row,payload:JSON.parse(row.payload_json)}
    expect(copy.payload).toMatchObject({shift_id:null,shift_link_recorded:true})
    expect(attachBalanceSnapshots(db,[copy])[0].payload).toMatchObject({shift_id:null,shift_link_recorded:true})
  })
  it('preserves an explicit queued absence of a shift from an older producer', () => {
    const copy=returnCopy('terminal');copy.payload.shift_id=null;delete copy.payload.shift_link_recorded
    db.prepare('UPDATE customer_returns SET shift_id=NULL WHERE id=?').run(copy.aggregate_id)
    expect(attachBalanceSnapshots(db,[copy])[0].payload).toMatchObject({shift_id:null,shift_link_recorded:true})
  })
  it('does not replace an explicit queued null with a subsequently changed local link', () => {
    const copy=returnCopy('terminal');copy.payload.shift_id=null
    const result=attachBalanceSnapshots(db,[copy])[0].payload
    expect(result).toMatchObject({shift_id:null,shift_link_recorded:true})
    expect(copy.payload.shift_id).toBeNull()
    expect(db.prepare('SELECT shift_id FROM customer_returns WHERE id=?').get(copy.aggregate_id)).toMatchObject({shift_id:shift})
  })
  it('does not erase an explicitly unknown queued decision or rewrite its recorded link', () => {
    const copy=returnCopy('terminal');copy.payload.shift_link_recorded=false
    const before=JSON.parse(JSON.stringify(copy.payload))
    const after=attachBalanceSnapshots(db,[copy])[0].payload
    expect(after.shift_link_recorded).toBe(false)
    expect(copy.payload).toEqual(before)
  })
  it('preserves explicitly saved metadata instead of rewriting the historical operation', () => {
    const copy = returnCopy(), original = JSON.parse(JSON.stringify(copy.payload))
    db.prepare('UPDATE customers SET deposit_balance=0 WHERE id=?').run(customer)
    db.prepare('UPDATE customer_deposit_transactions SET balance_after=9000 WHERE sale_id=?').run(sale)
    expect(attachBalanceSnapshots(db, [copy])[0].payload.deposit_transaction).toEqual(original.deposit_transaction)
  })
})
