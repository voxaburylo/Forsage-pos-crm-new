import { z } from 'zod'
import { calculateExpectedCash } from '../services/cashAccounting.js'

const id = z.string().trim().min(1)
const amount = z.number().int().refine(Number.isSafeInteger).refine(n => n >= 0)
const saleSchema = z.object({
 id, total: amount, status: z.string(), payment_method: z.string(), is_fiscal: z.boolean().nullish(),
 cash_amount: amount.nullable(), card_amount: amount.nullable(), transfer_amount: amount.nullable(),
 debt_amount: amount.nullable(), is_debt: z.boolean().nullable(),
}).passthrough()
const snapshotSchema = z.object({
 shift: z.object({ id, tenant_id: id, cashier_id: id, opening_cash: amount, status: z.enum(['open','closed']) }).passthrough(),
 sales: z.array(saleSchema),
 orders: z.array(z.object({ id, sale_id: id.nullable() })),
 payments: z.array(z.object({ id, order_id: id, amount, method: z.enum(['cash','card','transfer','account']), is_fiscal: z.boolean().nullish() })),
 operations: z.array(z.object({ id, type: z.enum(['in','out']), amount, created_by: id, refund: z.object({
   method: z.string(), status: z.string(), amount,
 }).nullable() })),
 refunds: z.array(z.object({
   id, sale_id: id, refund_method: z.string(), amount, shift_id: id.nullable(), shift_link_recorded: z.boolean().default(false), cash_shift_id: id.nullable(),
   cash_amount: amount.nullable(), sale_total: amount.nullable(), known_links: z.array(id), intervals: z.array(id),
 })),
})
type Methods = { cash: number; card: number; transfer: number; account: number; debt: number }
const emptyMethods = (): Methods => ({ cash:0,card:0,transfer:0,account:0,debt:0 })
function invalid(): never { throw new Error('Звіт зміни містить неповні або неузгоджені дані. Перевірте серверну копію.') }
function sum(...values: number[]) {
 const result = Number(values.reduce((total,value) => total + BigInt(value),0n))
 if (!Number.isSafeInteger(result)) invalid()
 return result
}
function unique<T extends { id: string }>(rows: T[]) {
 const map = new Map(rows.map(row => [row.id,row]))
 if (map.size !== rows.length) invalid()
 return map
}
function saleParts(sale: z.infer<typeof saleSchema>): Methods {
 if (!['cash','card','transfer','debt','mixed'].includes(sale.payment_method)) invalid()
 const parts = emptyMethods()
 for (const method of ['cash','card','transfer'] as const) {
   parts[method] = sale[`${method}_amount`] || (sale.payment_method === method ? sale.total : 0)
 }
 parts.debt = sale.debt_amount ?? ((sale.is_debt || sale.payment_method === 'debt')
   ? sum(sale.total,-parts.cash,-parts.card,-parts.transfer) : 0)
 if (parts.debt < 0 || sum(...Object.values(parts)) !== sale.total) invalid()
 return parts
}
export function aggregateShiftSnapshot(value: unknown, shiftId: string, tenantId: string) {
 const data = snapshotSchema.parse(value)
 if (data.shift.id !== shiftId || data.shift.tenant_id !== tenantId) invalid()
 unique(data.sales); unique(data.payments); unique(data.operations); unique(data.refunds)
 const orders = unique(data.orders), orderSales = new Set<string>()
 for (const order of orders.values()) if (order.sale_id !== null) {
   if (orderSales.has(order.sale_id)) invalid()
   orderSales.add(order.sale_id)
 }
 const received = emptyMethods(), fiscal = emptyMethods(), refunds = emptyMethods()
 const add = (target: Methods, parts: Methods) => {
   for (const key of Object.keys(target) as (keyof Methods)[]) target[key] = sum(target[key],parts[key])
 }
 let gross = 0, regularSaleCash = 0
 const settled = data.sales.filter(sale => ['completed','returned'].includes(sale.status))
 for (const sale of settled) {
   gross = sum(gross,sale.total)
   if (orderSales.has(sale.id)) continue // Money is counted when the order payment was accepted.
   const parts = saleParts(sale)
   add(received,parts); if (sale.is_fiscal) add(fiscal,parts)
   regularSaleCash = sum(regularSaleCash,parts.cash)
 }
 for (const payment of data.payments) {
   if (!orders.has(payment.order_id)) invalid()
   const parts = emptyMethods(); parts[payment.method] = payment.amount
   add(received,parts); if (payment.is_fiscal) add(fiscal,parts)
 }
 let cashIn = 0, cashOut = 0, cashReturn = 0
 const byUser = new Map<string,{user_id:string;cash_in:number;cash_out:number;count:number}>()
 for (const op of data.operations) {
   if (op.refund) {
     if (op.type !== 'out' || op.refund.method !== 'cash' || op.refund.status !== 'completed' || op.refund.amount !== op.amount) invalid()
     cashReturn = sum(cashReturn,op.amount)
   } else if (op.type === 'out') cashOut = sum(cashOut,op.amount)
   if (op.type === 'in') cashIn = sum(cashIn,op.amount)
   const user = byUser.get(op.created_by) ?? { user_id:op.created_by,cash_in:0,cash_out:0,count:0 }
   const key = op.type === 'in' ? 'cash_in' : 'cash_out'
   user[key] = sum(user[key],op.amount); user.count++
   byUser.set(user.user_id,user)
 }
 const methods = new Map<string,keyof Methods>([['cash','cash'],['terminal','card'],['credit','account'],['debt_reduction','debt']])
 let unassigned = 0
 const refundedBySale = new Map<string,number>()
 for (const refund of data.refunds) {
   if (refund.shift_link_recorded && refund.shift_id === null) {
     if (refund.cash_shift_id !== null || (refund.refund_method === 'cash' && refund.amount > 0)) invalid()
     continue // Explicitly recorded outside a cash shift, not missing metadata.
   }
   const exact = new Set([refund.shift_id,refund.cash_shift_id].filter((v): v is string => v !== null))
   if ([...exact].some(link => !refund.known_links.includes(link))) { unassigned++; continue }
   const evidence = exact.size ? exact : new Set(refund.intervals)
   if (evidence.size === 1 && !evidence.has(shiftId)) continue
   if (evidence.size !== 1 || !evidence.has(shiftId)) { unassigned++; continue }
   const method = methods.get(refund.refund_method)
   if (!method) invalid()
   if (refund.sale_total === null || refund.amount > refund.sale_total) invalid()
   if (method === 'cash' && (refund.cash_shift_id !== shiftId || refund.cash_amount !== refund.amount)) invalid()
   const previous = sum(refundedBySale.get(refund.sale_id) ?? 0,refund.amount)
   if (previous > refund.sale_total) invalid()
   refundedBySale.set(refund.sale_id,previous)
   refunds[method] = sum(refunds[method],refund.amount)
 }
 const refundTotal = sum(...Object.values(refunds)), paymentRefunded = sum(refundTotal,-refunds.debt)
 const paymentReceived = sum(received.cash,received.card,received.transfer,received.account)
 return {
   shift:data.shift,total_sales:settled.length,gross_revenue:gross,refund_total:refundTotal,
   total_revenue:sum(gross,-refundTotal),payment_received_total:paymentReceived,payment_refunded_total:paymentRefunded,
   payment_net_total:sum(paymentReceived,-paymentRefunded),by_method:received,refunds_by_method:refunds,
   unassigned_refunds_count:unassigned,
   cash_breakdown:{
     opening_cash:data.shift.opening_cash,cash_sales:regularSaleCash,cash_returns:cashReturn,cash_in:cashIn,cash_out:cashOut,
     expected_amount:calculateExpectedCash({openingCash:data.shift.opening_cash,regularSaleCash,cashIn,returnCash:cashReturn,cashOut}),
   },
   fiscal_breakdown:{
     cash_fiscal:fiscal.cash,cash_non_fiscal:sum(received.cash,-fiscal.cash),
     card_fiscal:fiscal.card,card_non_fiscal:sum(received.card,-fiscal.card),
     transfer_fiscal:fiscal.transfer,transfer_non_fiscal:sum(received.transfer,-fiscal.transfer),account_non_fiscal:received.account,
   },
   by_user:[...byUser.values()],sales:data.sales,
 }
}
