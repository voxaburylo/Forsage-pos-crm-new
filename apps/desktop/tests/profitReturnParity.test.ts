import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { localAnalytics } from '../src/repositories/localAnalytics'

describe('profit reports reconcile refunds, captured cost and integer receipt allocation', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, catalog: LocalCatalogRepository, shift: string
  const day = '2026-10-01'
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(day + 'T10:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-profit-refunds-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db); catalog = new LocalCatalogRepository(db)
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('seller', tenant, 'Контрольний касир', 'cashier', new Date().toISOString(), new Date().toISOString())
    shift = pos.openShift({ cashier_id: 'seller', opening_cash: 100000 })
  })
  afterEach(() => {
    db.close(); vi.useRealTimers()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-profit-refunds-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function product(price = 10000, cost = 6000) {
    return catalog.upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Контрольний товар',
      qty_on_hand: 100, retail_price: price, purchase_price: cost }).id
  }
  function sell(id: string, qty = 1, price = 10000) {
    return pos.checkout({ cashier_id: 'seller', shift_id: shift, client_operation_id: randomUUID(),
      items: [{ product_id: id, qty, unit_price: price }], payments: [{ method: 'cash', amount: Math.round(qty * price) }] }).sale_id
  }
  function refund(saleId: string, productId: string, action: string, quantity = 1) {
    const item = pos.getSaleForReturn(saleId).items.find((line: any) => line.product_id === productId)
    return pos.createReturn({ client_operation_id: randomUUID(), sale_id: saleId, approved_by: 'seller',
      shift_id: shift, stock_action: action, refund_method: 'cash',
      items: [{ sale_item_id: item.id, product_id: productId, quantity }] })
  }
  function reports(date = day, end = date) {
    const input = { kind: 'abc' as const, from: date + 'T00:00:00.000Z', to: end + 'T23:59:59.999Z', startDate: date, endDate: end }
    return { abc: localAnalytics(db, input), staff: localAnalytics(db, { ...input, kind: 'staff' }).find(row => row.manager_id === 'seller'),
      dashboard: pos.dashboardSummary({ date_from: input.from, date_to: input.to }).analytics }
  }
  it.each([['return_to_stock', 0, 0], ['write_off', -6000, 6000], ['send_to_supplier', -6000, 6000]] as const)(
    '%s full refund reverses cost only if goods return to stock', (action, profit, cost) => {
      const id = product(), sale = sell(id)
      // Today's catalog price is not the cost captured at sale time.
      db.prepare('UPDATE products SET purchase_price=99000 WHERE id=?').run(id)
      refund(sale, id, action)
      const report = reports()
      expect(report.dashboard).toMatchObject({ total_revenue: 0, cogs: cost, gross_profit: profit })
      expect(report.abc.find(row => row.id === id)).toMatchObject({ soldQty: 0, profit })
      expect(report.staff).toMatchObject({ total_revenue: 0, total_cogs: cost, gross_profit: profit })
    })
  it.each([['return_to_stock', 8000], ['write_off', 2000], ['send_to_supplier', 2000]] as const)(
    '%s partial refund retains the cost of damaged or quarantined goods', (action, profit) => {
      const id = product(), sale = sell(id, 3); refund(sale, id, action)
      const report = reports()
      expect(report.abc.find(row => row.id === id)).toMatchObject({ soldQty: 2, profit })
      expect(report.staff.gross_profit).toBe(profit)
      expect(report.dashboard.gross_profit).toBe(profit)
    })
  it.each([['return_to_stock', -4000], ['write_off', -10000], ['send_to_supplier', -10000]] as const)(
    '%s refund uses its own date even when that day has no sales', (action, returnDayProfit) => {
      const id = product(), sale = sell(id)
      vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); refund(sale, id, action)
      expect(reports().abc.find(row => row.id === id)?.profit).toBe(4000)
      const report = reports('2026-10-02')
      expect(report.abc.find(row => row.id === id)).toMatchObject({ soldQty: -1, profit: returnDayProfit })
      expect(report.staff.gross_profit).toBe(returnDayProfit)
      expect(report.dashboard.gross_profit).toBe(returnDayProfit)
    })
  it('allocates each discounted kopeck once across products, staff and the receipt', () => {
    const products = [product(100, 60), product(100, 60), product(100, 60)]
    const sale = pos.checkout({ cashier_id: 'seller', shift_id: shift, discount: 1,
      items: products.map(product_id => ({ product_id, qty: 1, unit_price: 100 })),
      payments: [{ method: 'cash', amount: 299 }] }).sale_id
    const report = reports()
    expect(report.abc.map(row => row.profit).sort()).toEqual([39, 40, 40])
    expect(report.abc.reduce((sum, row) => sum + row.profit, 0)).toBe(119)
    expect(report.staff.gross_profit).toBe(119)
    expect(report.dashboard.gross_profit).toBe(119)
    for (const id of products) refund(sale, id, 'return_to_stock')
    expect(reports().abc.map(row => row.profit)).toEqual([0, 0, 0])
  })
  it('does not redistribute a free-price or service line share to stock products', () => {
    const first = product(100, 60), second = product(100, 60)
    pos.checkout({ cashier_id: 'seller', shift_id: shift, discount: 1, items: [
      { product_id: first, qty: 1, unit_price: 100 }, { product_id: second, qty: 1, unit_price: 100 },
      { product_id: null, description: 'Послуга', qty: 1, unit_price: 100 },
    ], payments: [{ method: 'cash', amount: 299 }] })
    const report = reports(), sold = pos.soldItemsReport({ date_from: day + 'T00:00:00Z', date_to: day + 'T23:59:59Z' })
    for (const row of sold) expect(report.abc.find(item => item.id === row.product_id)?.profit).toBe(row.net_revenue - 60)
    expect(report.staff.gross_profit).toBe(179)
  })
  it('keeps historical product profit after archiving the card', () => {
    const id = product(); sell(id)
    db.prepare('UPDATE products SET is_active=0,deleted_at=? WHERE id=?').run(new Date().toISOString(), id)
    expect(reports().abc.find(row => row.id === id)).toMatchObject({ profit: 4000, soldQty: 1 })
  })
  it('records the original purchase cost in the return stock journal, not the selling price', () => {
    const id = product(), sale = sell(id)
    db.prepare('UPDATE products SET purchase_price=99000 WHERE id=?').run(id)
    const returned = refund(sale, id, 'return_to_stock')
    expect(db.prepare("SELECT unit_cost,qty_delta FROM inventory_movements WHERE source_type='customer_return' AND source_id=?")
      .get(returned.id)).toMatchObject({ unit_cost: 6000, qty_delta: 1 })
  })
  it('calculates both reports with database writes explicitly disabled', () => {
    const id = product(), sale = sell(id); refund(sale, id, 'write_off')
    db.exec('PRAGMA query_only=ON')
    try {
      const report = reports()
      expect(report.abc.find(row => row.id === id)?.profit).toBe(-6000)
      expect(report.staff.gross_profit).toBe(-6000)
    } finally { db.exec('PRAGMA query_only=OFF') }
  })
  it('rejects inconsistent receipt lines instead of fabricating a profit total', () => {
    const id = product(), sale = sell(id)
    db.prepare('UPDATE sale_items SET total=0 WHERE sale_id=?').run(sale)
    expect(() => reports()).toThrow('Receipt lines do not cover its total')
  })
  it('does not include an unrelated archived and unsold product', () => {
    const id = product()
    db.prepare('UPDATE products SET is_active=0,deleted_at=? WHERE id=?').run(new Date().toISOString(), id)
    expect(reports().abc.some(row => row.id === id)).toBe(false)
  })

  it('keeps old and future receipts outside the selected ABC day', () => {
    const id = product(); sell(id)
    vi.setSystemTime(new Date('2026-09-01T10:00:00Z')); sell(id)
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z')); sell(id)
    expect(reports().abc.find(row => row.id === id)).toMatchObject({ soldQty: 1, profit: 4000 })
  })
  it('uses the same A/B/C boundaries as the server, without putting a dominant item in C', () => {
    const fixtures = [[8000,0,'A'],[1500,0,'B'],[500,0,'C'],[100,500,'Z']] as const
    const ids = fixtures.map(([price,cost]) => { const id=product(price,cost);sell(id,1,price);return id })
    const rows = reports().abc
    expect(ids.map(id => rows.find(row => row.id===id)?.abc_class)).toEqual(['A','B','C','Z'])
    expect(rows.map(row => row.cumulative_pct)).toEqual([80,95,100,100])
  })
  it.each(['empty-receipt', 'empty-return', 'wrong-product', 'wrong-sale', 'header-mismatch', 'negative-cost'])(
    'rejects incomplete analytics instead of inventing amounts: %s', fault => {
      const id=product(), sale=sell(id), returned=refund(sale,id,'return_to_stock')
      if(fault==='empty-receipt')db.prepare('UPDATE sale_items SET deleted_at=? WHERE sale_id=?').run(new Date().toISOString(),sale)
      if(fault==='empty-return')db.prepare('UPDATE customer_return_items SET deleted_at=? WHERE return_id=?').run(new Date().toISOString(),returned.id)
      if(fault==='wrong-product')db.prepare('UPDATE customer_return_items SET product_id=? WHERE return_id=?').run(product(),returned.id)
      if(fault==='wrong-sale')db.prepare('UPDATE customer_returns SET sale_id=? WHERE id=?').run(sell(id),returned.id)
      if(fault==='header-mismatch')db.prepare('UPDATE customer_returns SET refund_kopecks=9000 WHERE id=?').run(returned.id)
      if(fault==='negative-cost')db.prepare('UPDATE sale_items SET purchase_price=-1 WHERE sale_id=?').run(sale)
      expect(()=>reports()).toThrow('неповні або не узгоджені')
    })
  it('reads one WAL snapshot without blocking a concurrent writer', () => {
    const id=product();sell(id)
    const writer=new LocalDatabase(root), prepare=db.prepare.bind(db)
    let changed=false
    const spy=vi.spyOn(db,'prepare').mockImplementation(sql=>{
      if(!changed && sql.includes('qty_on_hand currentStock')){
        changed=true;writer.prepare('UPDATE products SET qty_on_hand=77 WHERE id=?').run(id)
      }
      return prepare(sql)
    })
    try {
      expect(reports().abc.find(row=>row.id===id)).toMatchObject({currentStock:99,soldQty:1,profit:4000})
      expect(prepare('SELECT qty_on_hand FROM products WHERE id=?').get(id)).toMatchObject({qty_on_hand:77})
      expect(changed).toBe(true)
    }finally{spy.mockRestore();writer.close()}
  })

  it('keeps the receipt classification and manager after an order is archived', () => {
    const id = product(), sale = sell(id), timestamp = new Date().toISOString()
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('manager', tenant, 'Контрольний менеджер', 'manager', timestamp, timestamp)
    db.prepare("INSERT INTO customer_orders(id,tenant_id,order_number,manager_id,status,sale_id,created_at,updated_at) VALUES (?,?,?,?,'completed',?,?,?)")
      .run('order', tenant, 'ORDER-TEST', 'manager', sale, timestamp, timestamp)
    const input = { kind: 'staff' as const, from: day + 'T00:00:00Z', to: day + 'T23:59:59Z', startDate: day, endDate: day }
    const before = localAnalytics(db, input)
    db.prepare('UPDATE customer_orders SET deleted_at=? WHERE id=?').run(timestamp, 'order')
    expect(localAnalytics(db, input)).toEqual(before)
    expect(before.find(row => row.manager_id === 'manager')).toMatchObject({ orders_revenue: 10000, orders_cogs: 6000 })
  })
})
