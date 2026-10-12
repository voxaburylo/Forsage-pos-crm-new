// Independent per-product / per-employee oracle over an explicit standalone
// backup. No live database, constructor repairs, migrations, network or writes.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const thousandths = n => {
  const value = Math.round(n * 1000)
  assert(Number.isSafeInteger(value) && Math.abs(value - n * 1000) < .00001)
  return BigInt(value)
}
const roundedCost = n => Number(n >= 0n ? (n + 500n) / 1000n : -((-n + 499n) / 1000n))
// Direct rational apportionment. Do not call the production allocation helper.
function distribute(amount, weights) {
  const total = weights.reduce((sum, row) => sum + BigInt(row.weight), 0n)
  assert(Number.isSafeInteger(amount) && amount >= 0 && BigInt(amount) <= total)
  const rows = weights.map(row => {
    const n = BigInt(amount) * BigInt(row.weight)
    return { id: row.id, amount: total ? Number(n / total) : 0, fraction: total ? n % total : 0n }
  }).sort((a, b) => a.fraction === b.fraction ? a.id.localeCompare(b.id) : a.fraction > b.fraction ? -1 : 1)
  let remaining = amount - rows.reduce((sum, row) => sum + row.amount, 0)
  return new Map(rows.map(row => [row.id, row.amount + (remaining-- > 0 ? 1 : 0)]))
}
function allocation(sale, lines) {
  const cores = lines.map(line => ({ id: line.id, weight: Math.round(line.qty * (line.core_deposit_amount || 0)) }))
  const core = cores.reduce((sum, row) => sum + row.weight, 0)
  const coreAmounts = distribute(Math.min(sale.total, core), cores)
  const goods = distribute(Math.max(0, sale.total - core), lines.map((row, index) => ({ id: row.id, weight: row.total - cores[index].weight })))
  return new Map(lines.map(row => [row.id, coreAmounts.get(row.id) + goods.get(row.id)]))
}
function inspect(source, dist) {
  assert(path.isAbsolute(source) && path.isAbsolute(dist))
  source = fs.realpathSync(source)
  assert(!/[\\/]data[\\/]forsage\.db$/i.test(source), 'Use a standalone backup')
  for (const suffix of ['-wal', '-shm', '-journal']) assert(!fs.existsSync(source + suffix))
  const before = digest(source), started = performance.now()
  const { LocalPosReports } = require(path.join(dist, 'repositories/pos/reports.js'))
  const { localAnalytics } = require(path.join(dist, 'repositories/localAnalytics.js'))
  const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes.js'))
  const db = new DatabaseSync(source, { readOnly: true })
  const checks = { periods: 0, products: 0, sellers: 0, employees: 0, suppliers: 0 }, blocked = []
  try {
    db.exec('PRAGMA query_only=ON;BEGIN')
    const facade = { prepare: sql => db.prepare(sql), readSnapshot: work => work() }
    const report = new LocalPosReports(facade)
    const read = table => db.prepare(`SELECT * FROM ${table} WHERE tenant_id=?`).all(tenant)
    const sales = read('sales').filter(r => !r.deleted_at && ['completed', 'returned'].includes(r.status))
    const allLines = read('sale_items').filter(r => !r.deleted_at)
    const byLine = new Map(allLines.map(r => [r.id, r]))
    const returns = read('customer_returns').filter(r => !r.deleted_at && r.status === 'completed')
    const returnItems = read('customer_return_items').filter(r => !r.deleted_at)
    const products = new Map(read('products').map(r => [r.id, r]))
    const staff = read('staff_users'), salary = read('salary_payments').filter(r => !r.deleted_at)
    const orders = read('customer_orders')
    // This real-data corpus contains no deleted order links. Their business rule
    // must not be guessed here or silently made identical to a reader query.
    assert(!orders.some(o => o.deleted_at && sales.some(s => s.id === o.sale_id)), 'Archived order attribution needs separate review')
    const orderBySale = new Map(orders.filter(o => o.sale_id && !o.deleted_at).map(o => [o.sale_id, o]))
    const saleById = new Map(sales.map(r => [r.id, r]))
    const posted = new Map(read('supply_invoices').filter(r => !r.deleted_at && r.status === 'posted').map(r => [r.id, r]))
    const suppliers = new Set(read('suppliers').filter(r => !r.deleted_at).map(r => r.id))
    const sources = new Map()
    for (const row of read('supply_invoice_items')) {
      const invoice = posted.get(row.invoice_id)
      if (row.deleted_at || row.qty <= 0 || !invoice || !suppliers.has(invoice.supplier_id)) continue
      if (!sources.has(row.product_id)) sources.set(row.product_id, new Set())
      sources.get(row.product_id).add(invoice.supplier_id)
    }
    const linesBySale = new Map(sales.map(s => [s.id, allLines.filter(r => r.sale_id === s.id)]))
    const invalid = new Set(sales.filter(s => !linesBySale.get(s.id).length).map(s => s.id))
    const dateKey = n => new Date(n).toISOString().slice(0, 10)
    const periods = []
    // Kyiv summer-time corpus only; separate unit tests cover winter and DST.
    for (let date = Date.parse('2026-07-01T12:00:00Z'); date <= Date.parse('2026-10-12T12:00:00Z'); date += 86400000) {
      periods.push([dateKey(date), dateKey(date)])
    }
    periods.push(['2026-07-03', '2026-10-12'])
    for (const [first, last] of periods) {
      const from = first + 'T00:00:00+03:00', to = last + 'T23:59:59.999+03:00'
      const within = value => Date.parse(value) >= Date.parse(from) && Date.parse(value) <= Date.parse(to)
      const selected = sales.filter(s => within(s.completed_at || s.created_at))
      const refunds = returns.filter(r => within(r.created_at))
      if (selected.some(s => invalid.has(s.id)) || refunds.some(r => invalid.has(r.sale_id))) {
        assert.throws(() => report.soldItemsReport({ date_from: from, date_to: to }), /неповн|неузгоджен/i)
        assert.throws(() => localAnalytics(facade, { kind: 'staff', from, to, startDate: first, endDate: last }), /неповн|не узгоджен/i)
        blocked.push({ from: first, to: last }); continue
      }
      const goods = new Map(), employees = new Map()
      const blank = () => ({ qty_sold: 0, qty_returned: 0, revenue: 0, refund_total: 0 })
      const employee = id => {
        if (!employees.has(id)) employees.set(id, { sales_revenue: 0, orders_revenue: 0, salesCost: 0n, ordersCost: 0n,
          salary_cost: 0, bonus_cost: 0, advance_cost: 0, penalty_cost: 0 })
        return employees.get(id)
      }
      for (const s of staff) employee(s.id)
      function add(sale, line, qty, money, cost, refund) {
        const order = orderBySale.get(sale.id), id = sale.manager_id || order?.manager_id || sale.cashier_id || 'unknown'
        const emp = employee(id), prefix = order ? 'orders' : 'sales'
        emp[prefix + '_revenue'] += refund ? -money : money
        emp[prefix + 'Cost'] += cost
        if (!line.product_id || products.get(line.product_id)?.is_service) return
        assert(products.has(line.product_id), 'Missing catalog parent')
        if (!goods.has(line.product_id)) goods.set(line.product_id, { ...blank(), sellers: new Map() })
        const row = goods.get(line.product_id)
        if (!row.sellers.has(id)) row.sellers.set(id, blank())
        for (const target of [row, row.sellers.get(id)]) {
          target[refund ? 'qty_returned' : 'qty_sold'] += Number(thousandths(qty))
          target[refund ? 'refund_total' : 'revenue'] += money
        }
      }
      for (const sale of selected) {
        const lines = linesBySale.get(sale.id), amounts = allocation(sale, lines)
        for (const line of lines) add(sale, line, line.qty, amounts.get(line.id), thousandths(line.qty) * BigInt(line.purchase_price), false)
      }
      for (const refund of refunds) {
        const rows = returnItems.filter(r => r.return_id === refund.id)
        assert.equal(rows.reduce((sum, row) => sum + row.total_kopecks, 0), refund.refund_kopecks)
        for (const row of rows) {
          const line = byLine.get(row.sale_item_id), sale = saleById.get(refund.sale_id)
          assert(line && sale && line.sale_id === sale.id && line.product_id === row.product_id)
          const cost = refund.stock_action === 'return_to_stock' ? -thousandths(row.quantity) * BigInt(line.purchase_price) : 0n
          add(sale, line, row.quantity, row.total_kopecks, cost, true)
        }
      }
      const actualGoods = report.soldItemsReport({ date_from: from, date_to: to })
      assert.deepEqual(actualGoods.map(r => r.product_id).sort(), [...goods.keys()].sort())
      const totals = row => ({ qty_sold: row.qty_sold / 1000, qty_returned: row.qty_returned / 1000,
        qty_net: (row.qty_sold - row.qty_returned) / 1000, revenue: row.revenue, refund_total: row.refund_total,
        net_revenue: row.revenue - row.refund_total })
      for (const row of actualGoods) {
        const expected = goods.get(row.product_id)
        for (const [field, value] of Object.entries(totals(expected))) assert.equal(row[field], value, `${first} goods ${field}`)
        assert.deepEqual(row.sellers.map(s => s.id).sort(), [...expected.sellers.keys()].map(id => id === 'unknown' ? '__unknown__' : id).sort())
        for (const seller of row.sellers) {
          for (const [field, value] of Object.entries(totals(expected.sellers.get(seller.id === '__unknown__' ? 'unknown' : seller.id)))) {
            assert.equal(seller[field], value, `${first} seller ${field}`)
          }
          checks.sellers++
        }
        assert.deepEqual(row.suppliers.map(s => s.id).sort(), [...(sources.get(row.product_id) || [])].sort())
        checks.suppliers += row.suppliers.length; checks.products++
      }
      const owners = new Set(staff.filter(s => s.role === 'owner').map(s => s.id))
      for (const row of salary.filter(s => s.work_date >= first && s.work_date <= last && !owners.has(s.employee_id))) {
        assert(['salary', 'bonus', 'advance', 'penalty'].includes(row.type))
        employee(row.employee_id)[row.type + '_cost'] += row.amount
      }
      const actualStaff = localAnalytics(facade, { kind: 'staff', from, to, startDate: first, endDate: last })
      assert.deepEqual(actualStaff.map(r => r.manager_id).sort(), [...employees.keys()].sort())
      for (const row of actualStaff) {
        const expected = employees.get(row.manager_id), total_revenue = expected.sales_revenue + expected.orders_revenue
        const total_cogs = roundedCost(expected.salesCost + expected.ordersCost), sales_cogs = roundedCost(expected.salesCost)
        const values = { sales_revenue: expected.sales_revenue, orders_revenue: expected.orders_revenue,
          sales_cogs, orders_cogs: total_cogs - sales_cogs, total_cogs, total_revenue,
          gross_profit: total_revenue - total_cogs, salary_cost: expected.salary_cost, bonus_cost: expected.bonus_cost,
          advance_cost: expected.advance_cost, penalty_cost: expected.penalty_cost, total_payouts: expected.advance_cost,
          net_profit: total_revenue - total_cogs - expected.salary_cost - expected.bonus_cost + expected.penalty_cost }
        for (const [field, value] of Object.entries(values)) assert.equal(row[field], value, `${first} employee ${field}`)
        checks.employees++
      }
      checks.periods++
    }
    assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1)
    db.exec('ROLLBACK')
    assert.equal(digest(source), before)
    return { success: true, sourceUnchanged: true, readOnly: true, shopDatabaseOpened: false, checks, blocked,
      sourceHash: before, elapsedMs: Math.round(performance.now() - started),
      scope: 'Amounts/quantities/sellers/supplier membership/stored salary costs; not commission entitlement or physical stock.' }
  } finally { db.close() }
}
if (require.main === module) {
  try { console.log(JSON.stringify(inspect(...process.argv.slice(2)), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { inspect, distribute, allocation, roundedCost }
