type Sale = {
  id: string; total: number; selected: boolean; sale_number: string; status: string; completed_at: string;
  payment_method: string; cash_amount: number | null; card_amount: number | null; transfer_amount: number | null;
  debt_amount: number | null; is_debt: boolean; customer_id: string | null;
  customer: { id: string; phone: string; full_name: string | null } | null;
}
type Line = { id: string; sale_id: string; qty: number; total: number; cost: number }
type Refund = { id: string; sale_id: string; created_at: string; amount: number; stock_action: string }
type RefundLine = { id: string; return_id: string; sale_item_id: string; quantity: number; total_kopecks: number }
export type PeriodSnapshot = {
  sales: Sale[]; lines: Line[]; returns: Refund[]; refundLines: RefundLine[];
  orders: { id: string; sale_id: string | null }[];
  payments: { id: string; order_id: string; amount: number; method: string; created_at: string }[];
}
export const INCOMPLETE_PERIOD = 'Фінансовий звіт містить неповні або неузгоджені дані. Перевірте чеки та серверну копію.'
function invalid(): never { throw new Error(INCOMPLETE_PERIOD) }
const money = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
function sum(a: number, b: number) { const n = a + b; if (!Number.isSafeInteger(n)) invalid(); return n }
function qty(n: number) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < .001) invalid()
  const scaled = Math.round(n * 1000)
  if (!Number.isSafeInteger(scaled) || Math.abs(n * 1000 - scaled) > .00001) invalid()
  return scaled
}
function unique<T extends { id: string }>(rows: T[]) {
  const result = new Map<string, T>()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || result.has(row.id)) invalid()
    result.set(row.id, row)
  }
  return result
}
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit' })
export function periodDate(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10)) invalid()
  const parts = dateFormatter.formatToParts(new Date(value))
  return ['year','month','day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}
export function aggregatePeriod(data: PeriodSnapshot, from: string, to: string) {
  if (!data || !['sales','lines','returns','refundLines','orders','payments'].every(key => Array.isArray(data[key as keyof PeriodSnapshot]))) invalid()
  const sales = unique(data.sales), lines = unique(data.lines), refunds = unique(data.returns), orders = unique(data.orders)
  unique(data.refundLines); unique(data.payments)
  const byMethod = { cash: 0, card: 0, transfer: 0, account: 0, debt: 0 }
  const daily = new Map<string, { date: string; sales: number; gross_revenue: number; returns_total: number; revenue: number }>()
  const day = (at: string) => {
    const key = periodDate(at)
    if (key < from || key > to) invalid()
    const row = daily.get(key) ?? { date: key, sales: 0, gross_revenue: 0, returns_total: 0, revenue: 0 }
    daily.set(key,row); return row
  }
  const orderSales = new Set<string>()
  for (const order of orders.values()) if (order.sale_id !== null) {
    if (orderSales.has(order.sale_id)) invalid()
    orderSales.add(order.sale_id)
  }
  const costs = new Map<string,number>(), lineTotals = new Map<string,number>()
  for (const line of lines.values()) {
    if (!sales.has(line.sale_id) || !money(line.cost) || !money(line.total)) invalid()
    const cost = Math.round(qty(line.qty) * line.cost / 1000)
    costs.set(line.sale_id,sum(costs.get(line.sale_id) ?? 0,cost))
    lineTotals.set(line.sale_id,sum(lineTotals.get(line.sale_id) ?? 0,line.total))
  }
  let revenue = 0, profit = 0, returnsTotal = 0
  const selected: Sale[] = []
  for (const sale of sales.values()) {
    if (!money(sale.total) || typeof sale.selected !== 'boolean' || !['completed','returned'].includes(sale.status)
      || !costs.has(sale.id) || (lineTotals.get(sale.id) ?? 0) < sale.total
      || typeof sale.sale_number !== 'string' || typeof sale.is_debt !== 'boolean'
      || (sale.customer_id !== null && sale.customer?.id !== sale.customer_id)) invalid()
    periodDate(sale.completed_at)
    if (!sale.selected) continue
    selected.push(sale); revenue = sum(revenue,sale.total); profit = sum(profit,sale.total - costs.get(sale.id)!)
    const row = day(sale.completed_at); row.sales++; row.gross_revenue = sum(row.gross_revenue,sale.total)
    if (orderSales.has(sale.id)) continue // Payments are counted on their own dates.
    const methods = ['cash','card','transfer','debt']
    if (!methods.includes(sale.payment_method) && sale.payment_method !== 'mixed') invalid()
    const parts = { cash: 0, card: 0, transfer: 0, debt: 0 }
    for (const kind of ['cash','card','transfer'] as const) {
      const value = sale[`${kind}_amount`]
      if (value !== null && !money(value)) invalid()
      parts[kind] = value || (sale.payment_method === kind ? sale.total : 0)
    }
    if (sale.debt_amount !== null && !money(sale.debt_amount)) invalid()
    parts.debt = sale.debt_amount ?? ((sale.is_debt || sale.payment_method === 'debt')
      ? sale.total - parts.cash - parts.card - parts.transfer : 0)
    if (!money(parts.debt) || Object.values(parts).reduce(sum,0) !== sale.total) invalid()
    for (const kind of ['cash','card','transfer','debt'] as const) byMethod[kind] = sum(byMethod[kind],parts[kind])
  }
  const refundAmounts = new Map<string,number>(), restoredCosts = new Map<string,number>(), returnedQty = new Map<string,number>()
  for (const line of data.refundLines) {
    const refund = refunds.get(line.return_id), source = lines.get(line.sale_item_id)
    if (!refund || !source || source.sale_id !== refund.sale_id || !money(line.total_kopecks)) invalid()
    const units = qty(line.quantity), accumulated = sum(returnedQty.get(source.id) ?? 0,units)
    if (accumulated > qty(source.qty)) invalid()
    returnedQty.set(source.id,accumulated)
    refundAmounts.set(refund.id,sum(refundAmounts.get(refund.id) ?? 0,line.total_kopecks))
    restoredCosts.set(refund.id,sum(restoredCosts.get(refund.id) ?? 0,Math.round(units * source.cost / 1000)))
  }
  for (const refund of refunds.values()) {
    if (!sales.has(refund.sale_id) || !money(refund.amount) || refundAmounts.get(refund.id) !== refund.amount
      || !['return_to_stock','write_off','send_to_supplier'].includes(refund.stock_action)) invalid()
    returnsTotal = sum(returnsTotal,refund.amount)
    profit = sum(profit,-refund.amount + (refund.stock_action === 'return_to_stock' ? restoredCosts.get(refund.id)! : 0))
    const row = day(refund.created_at); row.returns_total = sum(row.returns_total,refund.amount)
  }
  for (const payment of data.payments) {
    if (!orders.has(payment.order_id) || !money(payment.amount) || !['cash','card','transfer','account'].includes(payment.method)) invalid()
    day(payment.created_at)
    const kind = payment.method as 'cash' | 'card' | 'transfer' | 'account'
    byMethod[kind] = sum(byMethod[kind],payment.amount)
  }
  for (const row of daily.values()) row.revenue = sum(row.gross_revenue,-row.returns_total)
  selected.sort((a,b) => Date.parse(b.completed_at)-Date.parse(a.completed_at) || a.id.localeCompare(b.id))
  return {
    total_sales: selected.length, total_revenue: revenue, returns_count: refunds.size, returns_total: returnsTotal,
    net_revenue: sum(revenue,-returnsTotal), profit, by_method: byMethod,
    payment_received_total: [byMethod.cash,byMethod.card,byMethod.transfer,byMethod.account].reduce(sum,0),
    sales: selected.map(s => ({ id:s.id,sale_number:s.sale_number,total:s.total,payment_method:s.payment_method,
      status:s.status,completed_at:s.completed_at,customer:s.customer })),
    daily: [...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),
  }
}
