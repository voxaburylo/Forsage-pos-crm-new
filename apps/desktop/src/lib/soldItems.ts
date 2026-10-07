import { allocateReceiptRevenue } from './receiptRevenue'

type Sale = { id: string; total: number; selected: boolean; manager_id: string | null; cashier_id: string | null }
type Line = { id: string; sale_id: string; product_id: string | null; qty: number; total: number; coreTotal: number }
type Refund = { id: string; sale_id: string; amount: number }
type RefundLine = { id: string; return_id: string; sale_item_id: string; product_id: string | null; quantity: number; total_kopecks: number }
type Product = { id: string; sku: string; barcode: string | null; name: string; unit: string; qty_on_hand: number; storage_bin: string | null; is_service: boolean }
type Supplier = { product_id: string; id: string; name: string }
export type SoldSnapshot = {
  sales: Sale[]; lines: Line[]; returns: Refund[]; refundLines: RefundLine[]; products: Product[];
  suppliers: Supplier[]; staff: { id: string; name: string | null }[];
  orders: { id: string; sale_id: string; manager_id: string | null }[];
}
type Totals = { qty_sold: number; qty_returned: number; qty_net: number; revenue: number; refund_total: number; net_revenue: number }
export type SoldReportItem = Omit<Product, 'id' | 'is_service'> & Totals & {
  product_id: string; suppliers: { id: string; name: string }[];
  sellers: (Totals & { id: string; name: string })[];
}
const emptyTotals = (): Totals => ({ qty_sold: 0, qty_returned: 0, qty_net: 0, revenue: 0, refund_total: 0, net_revenue: 0 })
function incomplete(): never { throw new Error('Звіт проданих товарів містить неповні або неузгоджені дані. Перевірте чеки та резервну копію.') }
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const nullableId = (value: unknown) => value === null || id(value)
const money = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function quantity(value: number, positive = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) incomplete()
  const scaled = Math.round(value * 1000)
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled - value * 1000) > .00001) incomplete()
  return scaled
}
function unique<T extends { id: string }>(rows: T[]) {
  const result = new Map<string, T>()
  for (const row of rows) {
    if (!row || !id(row.id) || result.has(row.id)) incomplete()
    result.set(row.id, row)
  }
  return result
}
export function validSoldDateRange(from: string, to: string) {
  const valid = (value: string) => {
    const date = new Date(value + 'T00:00:00Z')
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
      && date.toISOString().slice(0, 10) === value && +value.slice(0, 4) >= 1000 && +value.slice(0, 4) < 9999
  }
  return typeof from === 'string' && typeof to === 'string' && valid(from) && valid(to) && from <= to
}

// Both readers supply one consistent snapshot. Integer thousandths prevent
// floating quantity drift; all money is integer kopecks. Never clamp refunds.
export function aggregateSoldItems(data: SoldSnapshot): SoldReportItem[] {
  if (!data || !['sales','lines','returns','refundLines','products','suppliers','staff','orders']
    .every(key => Array.isArray(data[key as keyof SoldSnapshot]))) incomplete()
  const sales = unique(data.sales), lines = unique(data.lines), refunds = unique(data.returns)
  unique(data.refundLines)
  const products = unique(data.products), staff = unique(data.staff)
  const orderBySale = new Map<string, SoldSnapshot['orders'][number]>()
  unique(data.orders)
  for (const order of data.orders) {
    if (!sales.has(order.sale_id) || orderBySale.has(order.sale_id) || !nullableId(order.manager_id)) incomplete()
    orderBySale.set(order.sale_id, order)
  }
  for (const person of staff.values()) if (person.name !== null && typeof person.name !== 'string') incomplete()
  for (const product of products.values()) {
    if (![product.sku, product.name, product.unit].every(value => typeof value === 'string')
      || !product.name.trim() || typeof product.is_service !== 'boolean'
      || (product.barcode !== null && typeof product.barcode !== 'string')
      || (product.storage_bin !== null && typeof product.storage_bin !== 'string')) incomplete()
    quantity(product.qty_on_hand, false)
  }
  const saleLines = new Map<string, Line[]>()
  for (const line of lines.values()) {
    if (!sales.has(line.sale_id) || !nullableId(line.product_id) || !money(line.total) || !money(line.coreTotal)) incomplete()
    quantity(line.qty)
    if (line.product_id && !products.has(line.product_id)) incomplete()
    const items = saleLines.get(line.sale_id) ?? []
    items.push(line); saleLines.set(line.sale_id, items)
  }
  const result = new Map<string, SoldReportItem>()
  const sellerFor = (sale: Sale) => {
    const key = sale.manager_id || orderBySale.get(sale.id)?.manager_id || sale.cashier_id || '__unknown__'
    return { id: key, name: staff.get(key)?.name?.trim() || 'Невідомий працівник' }
  }
  const add = (productId: string | null, sale: Sale, qty: number, amount: number, returned: boolean) => {
    if (!productId) return // free-price lines are validated/allocated, but are not catalog goods
    const product = products.get(productId)!
    if (product.is_service) return
    let row = result.get(productId)
    if (!row) {
      const { id: product_id, is_service: _service, ...metadata } = product
      row = { ...metadata, product_id, ...emptyTotals(), suppliers: [], sellers: [] }
      result.set(productId, row)
    }
    const seller = sellerFor(sale)
    let part = row.sellers.find(item => item.id === seller.id)
    if (!part) { part = { ...seller, ...emptyTotals() }; row.sellers.push(part) }
    for (const total of [row, part]) {
      total[returned ? 'qty_returned' : 'qty_sold'] += quantity(qty)
      total[returned ? 'refund_total' : 'revenue'] += amount
    }
  }
  for (const sale of sales.values()) {
    if (!money(sale.total) || typeof sale.selected !== 'boolean'
      || !nullableId(sale.manager_id) || !nullableId(sale.cashier_id)) incomplete()
    const items = saleLines.get(sale.id) ?? []
    if (!items.length) incomplete()
    let allocation: Map<string, number>
    try { allocation = allocateReceiptRevenue(sale.total, items) } catch { incomplete() }
    if (sale.selected) for (const line of items) add(line.product_id, sale, line.qty, allocation.get(line.id)!, false)
  }
  const refundLines = new Map<string, RefundLine[]>(), returnedQty = new Map<string, number>()
  for (const line of data.refundLines) {
    const refund = refunds.get(line.return_id), source = lines.get(line.sale_item_id)
    if (!refund || !source || source.sale_id !== refund.sale_id || line.product_id !== source.product_id
      || !money(line.total_kopecks)) incomplete()
    const qty = quantity(line.quantity) + (returnedQty.get(source.id) ?? 0)
    if (qty > quantity(source.qty)) incomplete()
    returnedQty.set(source.id, qty)
    const items = refundLines.get(refund.id) ?? []
    items.push(line); refundLines.set(refund.id, items)
  }
  for (const refund of refunds.values()) {
    const sale = sales.get(refund.sale_id), items = refundLines.get(refund.id) ?? []
    if (!sale || !money(refund.amount) || !items.length
      || items.reduce((sum, line) => sum + line.total_kopecks, 0) !== refund.amount) incomplete()
    for (const line of items) add(line.product_id, sale, line.quantity, line.total_kopecks, true)
  }
  for (const supplier of data.suppliers) {
    if (!id(supplier.id) || !id(supplier.name) || !products.has(supplier.product_id)) incomplete()
    const row = result.get(supplier.product_id)
    if (row && !row.suppliers.some(item => item.id === supplier.id)) row.suppliers.push({ id: supplier.id, name: supplier.name })
  }
  for (const row of result.values()) {
    for (const total of [row, ...row.sellers]) {
      total.qty_net = total.qty_sold - total.qty_returned
      total.net_revenue = total.revenue - total.refund_total
      if (Object.keys(emptyTotals()).some(key => !Number.isSafeInteger(total[key as keyof Totals]))) incomplete()
      total.qty_sold /= 1000; total.qty_returned /= 1000; total.qty_net /= 1000
    }
    row.suppliers.sort((a,b) => a.name.localeCompare(b.name,'uk') || a.id.localeCompare(b.id))
    row.sellers.sort((a,b) => a.name.localeCompare(b.name,'uk') || a.id.localeCompare(b.id))
  }
  for (const field of ['revenue','refund_total','net_revenue'] as const) {
    if (!Number.isSafeInteger([...result.values()].reduce((sum,row) => sum + row[field],0))) incomplete()
  }
  return [...result.values()].sort((a,b) => b.qty_net - a.qty_net || a.name.localeCompare(b.name,'uk') || a.product_id.localeCompare(b.product_id))
}
