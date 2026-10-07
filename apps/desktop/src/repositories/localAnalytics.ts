import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { allocateReceiptRevenue } from '../lib/receiptRevenue'

interface AnalyticsInput {
  kind: 'abc' | 'staff'
  from: string
  to: string
  startDate: string
  endDate: string
}
interface Entry {
  product_id: string | null
  qty: number
  revenue: number
  cost: number
  employee_id: string | null
  order_id: string | null
}
interface SaleLine {
  id: string
  sale_id: string
  product_id: string | null
  qty: number
  purchase_price: number
  total: number
  coreTotal: number
  receipt_total: number
  employee_id: string | null
  order_id: string | null
}

function validCalendarDate(value: string): boolean {
  const date = new Date(value + 'T00:00:00Z')
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1000
    && Number(value.slice(0, 4)) < 9999
}

export function localAnalytics(db: LocalDatabase, input: AnalyticsInput): any[] {
  if (!validCalendarDate(input.startDate) || !validCalendarDate(input.endDate) || input.startDate > input.endDate
    || !['abc', 'staff'].includes(input.kind) || !Number.isFinite(Date.parse(input.from))
    || !Number.isFinite(Date.parse(input.to)) || Date.parse(input.from) > Date.parse(input.to)) {
    throw new Error('Некоректний період')
  }
  return db.readSnapshot(() => readLocalAnalytics(db, input))
}

function readLocalAnalytics(db: LocalDatabase, input: AnalyticsInput): any[] {
  const tenant = DEFAULT_TENANT_ID
  // Never present a partly mirrored/deleted receipt or unmatched return as
  // unsold stock or zero cost. All reads use the same non-writing WAL snapshot.
  const incompleteSale = db.prepare(`
    SELECT s.id FROM sales s LEFT JOIN sale_items si
      ON si.sale_id=s.id AND si.tenant_id=s.tenant_id AND si.deleted_at IS NULL
    WHERE s.tenant_id=? AND s.deleted_at IS NULL AND s.status IN ('completed','returned')
      AND COALESCE(s.completed_at,s.created_at)>=? AND COALESCE(s.completed_at,s.created_at)<=?
    GROUP BY s.id HAVING COUNT(si.id)=0 OR SUM(CASE WHEN si.purchase_price IS NULL
      OR si.purchase_price<0 OR si.qty<=0 THEN 1 ELSE 0 END)>0 LIMIT 1
  `).get(tenant, input.from, input.to)
  const incompleteReturn = db.prepare(`
    SELECT r.id FROM customer_returns r
    LEFT JOIN customer_return_items ri ON ri.return_id=r.id AND ri.tenant_id=r.tenant_id AND ri.deleted_at IS NULL
    LEFT JOIN sale_items si ON si.id=ri.sale_item_id AND si.tenant_id=r.tenant_id AND si.sale_id=r.sale_id
    LEFT JOIN sales s ON s.id=r.sale_id AND s.tenant_id=r.tenant_id AND s.status IN ('completed','returned')
    WHERE r.tenant_id=? AND r.deleted_at IS NULL AND r.status='completed'
      AND r.created_at>=? AND r.created_at<=?
    GROUP BY r.id HAVING COUNT(ri.id)=0 OR SUM(ri.total_kopecks)<>r.refund_kopecks
      OR SUM(CASE WHEN si.id IS NULL OR s.id IS NULL OR si.purchase_price IS NULL
        OR si.purchase_price<0 OR ri.product_id IS NOT si.product_id OR ri.quantity<=0
        OR ri.total_kopecks<0 THEN 1 ELSE 0 END)>0 LIMIT 1
  `).get(tenant, input.from, input.to)
  if (incompleteSale || incompleteReturn) {
    throw new Error('Дані товарного звіту неповні або не узгоджені. Потрібна перевірка чеків і повернень.')
  }
  const duplicateOrderLink = db.prepare(`
    SELECT o.sale_id FROM customer_orders o JOIN sales s ON s.id=o.sale_id AND s.tenant_id=o.tenant_id
    WHERE o.tenant_id=? AND s.status IN ('completed','returned') AND (
      (COALESCE(s.completed_at,s.created_at)>=? AND COALESCE(s.completed_at,s.created_at)<=?)
      OR EXISTS (SELECT 1 FROM customer_returns r WHERE r.sale_id=s.id AND r.tenant_id=s.tenant_id
        AND r.deleted_at IS NULL AND r.status='completed' AND r.created_at>=? AND r.created_at<=?))
    GROUP BY o.sale_id HAVING COUNT(*)>1 LIMIT 1
  `).get(tenant, input.from, input.to, input.from, input.to)
  if (duplicateOrderLink) throw new Error('Один чек прив’язаний до кількох замовлень. Звіт потребує перевірки.')
  const lines = db.prepare(`
    SELECT si.id, si.sale_id, si.product_id, si.qty, COALESCE(si.purchase_price, 0) purchase_price,
      si.total, CAST(ROUND(si.qty * COALESCE(si.core_deposit_amount, 0)) AS INTEGER) coreTotal,
      s.total receipt_total, COALESCE(s.manager_id, o.manager_id, s.cashier_id) employee_id, o.id order_id
    FROM sale_items si JOIN sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
    LEFT JOIN customer_orders o ON o.sale_id=s.id AND o.tenant_id=s.tenant_id
    WHERE si.tenant_id=? AND si.deleted_at IS NULL AND s.deleted_at IS NULL
      AND s.status IN ('completed','returned')
      AND COALESCE(s.completed_at,s.created_at)>=? AND COALESCE(s.completed_at,s.created_at)<=?
  `).all(tenant, input.from, input.to) as unknown as SaleLine[]

  // Use the same integer allocation as the sold-items report. Allocate before
  // filtering services/free-price lines so their discounts stay with them.
  const receipts = new Map<string, SaleLine[]>()
  for (const line of lines) {
    const receipt = receipts.get(line.sale_id) ?? []
    receipt.push(line)
    receipts.set(line.sale_id, receipt)
  }
  const entries: Entry[] = []
  for (const receipt of receipts.values()) {
    const allocated = allocateReceiptRevenue(Number(receipt[0].receipt_total), receipt)
    for (const line of receipt) entries.push({
      product_id: line.product_id, qty: Number(line.qty), revenue: allocated.get(line.id)!,
      cost: Number(line.qty) * Number(line.purchase_price),
      employee_id: line.employee_id, order_id: line.order_id,
    })
  }

  // Refunds belong to their own date. Damaged/quarantined goods do not restore
  // stock and must not make their historical cost disappear from profit.
  const returns = db.prepare(`
    SELECT ri.product_id, -ri.quantity qty, -ri.total_kopecks revenue,
      CASE WHEN r.stock_action='return_to_stock'
        THEN -ri.quantity * COALESCE(si.purchase_price, 0) ELSE 0 END cost,
      COALESCE(s.manager_id, o.manager_id, s.cashier_id) employee_id, o.id order_id
    FROM customer_return_items ri
    JOIN customer_returns r ON r.id=ri.return_id AND r.tenant_id=ri.tenant_id
    JOIN sale_items si ON si.id=ri.sale_item_id AND si.tenant_id=ri.tenant_id AND si.sale_id=r.sale_id
    JOIN sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
    LEFT JOIN customer_orders o ON o.sale_id=s.id AND o.tenant_id=s.tenant_id
    WHERE ri.tenant_id=? AND ri.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status='completed'
      AND r.created_at>=? AND r.created_at<=?
  `).all(tenant, input.from, input.to) as unknown as Entry[]
  entries.push(...returns)

  if (input.kind === 'abc') {
    const involved = new Set(entries.map(line => line.product_id))
    const products = db.prepare(`
      SELECT id, sku, name, qty_on_hand currentStock, is_active, deleted_at
      FROM products WHERE tenant_id=? AND is_service=0
    `).all(tenant) as { id: string; sku: string; name: string; currentStock: number; is_active: number; deleted_at: string | null }[]
    // Archiving a card must not erase its period history. Unrelated archived
    // cards stay out of the report, while active unsold stock remains visible.
    const map = new Map(products.filter(p => (p.is_active === 1 && p.deleted_at === null) || involved.has(p.id))
      .map(({ id, sku, name, currentStock }) => [id, { id, sku, name, currentStock, soldQty: 0, profit: 0 }]))
    for (const line of entries) {
      const product = line.product_id ? map.get(line.product_id) : undefined
      if (!product) continue
      product.soldQty = Math.round((product.soldQty + Number(line.qty)) * 1000) / 1000
      product.profit += Number(line.revenue) - Number(line.cost)
    }
    const rows = [...map.values()].sort((a, b) => b.profit - a.profit || a.id.localeCompare(b.id))
    const total = rows.reduce((sum, row) => sum + Math.max(0, row.profit), 0)
    let cumulative = 0
    return rows.map(row => {
      const before = total ? cumulative / total : 0
      cumulative += Math.max(0, row.profit)
      return { ...row, profit: Math.round(row.profit), cumulative_pct: total ? 100 * cumulative / total : 0,
        abc_class: row.soldQty <= 0 || row.profit <= 0 ? 'Z' : before < .8 ? 'A' : before < .95 ? 'B' : 'C' }
    })
  }

  const staff = db.prepare('SELECT id,full_name,role FROM staff_users WHERE tenant_id=?').all(tenant) as { id: string; full_name: string; role: string }[]
  const ownerIds = new Set(staff.filter(person => person.role === 'owner').map(person => person.id))
  const makeEmployee = (id: string, name?: string) => ({
    manager_id: id, manager_name: name?.trim() || 'Невідомий працівник',
    sales_revenue: 0, sales_cogs: 0, orders_revenue: 0, orders_cogs: 0,
    salary_cost: 0, bonus_cost: 0, advance_cost: 0, penalty_cost: 0,
  })
  const map = new Map(staff.map(person => [person.id, makeEmployee(person.id, person.full_name)]))
  const employeeFor = (id: string | null, name?: string) => {
    const key = id || 'unknown'
    if (!map.has(key)) map.set(key, makeEmployee(key, name))
    return map.get(key)!
  }
  // Missing/archived staff must not make recorded turnover disappear.
  for (const line of entries) {
    const employee = employeeFor(line.employee_id)
    if (line.order_id) {
      employee.orders_revenue += Number(line.revenue); employee.orders_cogs += Number(line.cost)
    } else {
      employee.sales_revenue += Number(line.revenue); employee.sales_cogs += Number(line.cost)
    }
  }
  const salary = db.prepare(`
    SELECT employee_id, employee_name, type, amount, source FROM salary_payments
    WHERE tenant_id=? AND deleted_at IS NULL AND work_date>=? AND work_date<=?
  `).all(tenant, input.startDate, input.endDate) as {
    employee_id: string; employee_name: string; type: 'salary' | 'bonus' | 'advance' | 'penalty'; amount: number; source: string
  }[]
  for (const row of salary) {
    if (ownerIds.has(row.employee_id)) continue
    if (!['salary', 'bonus', 'advance', 'penalty'].includes(row.type) || !Number.isSafeInteger(row.amount)
      || (row.amount < 0 && !(row.type === 'bonus' && row.source === 'commission_reversal'))) {
      throw new Error('Звіт працівників містить некоректне нарахування зарплати')
    }
    employeeFor(row.employee_id, row.employee_name)[`${row.type}_cost`] += row.amount
  }
  return [...map.values()].map(employee => {
    const total_revenue = Math.round(employee.sales_revenue + employee.orders_revenue)
    const total_cogs = Math.round(employee.sales_cogs + employee.orders_cogs)
    const sales_cogs = Math.round(employee.sales_cogs)
    const orders_cogs = total_cogs - sales_cogs
    const gross_profit = total_revenue - total_cogs
    const result = { ...employee, sales_cogs, orders_cogs, total_revenue, total_cogs, gross_profit,
      total_payouts: employee.advance_cost,
      net_profit: gross_profit - employee.salary_cost - employee.bonus_cost + employee.penalty_cost }
    if (Object.entries(result).some(([key, value]) => !key.startsWith('manager_') && !Number.isSafeInteger(value))) {
      throw new Error('Звіт працівників містить некоректні суми')
    }
    return result
  }).sort((a, b) => b.net_profit - a.net_profit || a.manager_id.localeCompare(b.manager_id))
}
