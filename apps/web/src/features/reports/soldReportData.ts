import { z } from 'zod'
import type { SoldItem } from '@/types/report'
import { offlineProductMatchesQuery } from '@/lib/offlineDB'
import { filterSoldBySupplier, soldSupplierNames } from './soldSupplierReport'
export { validStaffRange as validSoldRange } from '@/features/analytics/staffData'

export const soldReportNote = 'Продажі — за датою чека, повернення — за датою повернення. Чистий підсумок може бути від’ємним. Це сума товарів, не залишок грошей у касі.'
const money = z.number().int().safe()
const qty = z.number().finite().refine(n => Number.isSafeInteger(Math.round(n*1000)) && Math.abs(n*1000-Math.round(n*1000))<.00001)
const totals = {
  qty_sold: qty.refine(n=>n>=0), qty_returned: qty.refine(n=>n>=0), qty_net: qty,
  revenue: money.nonnegative(), refund_total: money.nonnegative(), net_revenue: money,
}
const consistent = (row: {qty_sold:number;qty_returned:number;qty_net:number;revenue:number;refund_total:number;net_revenue:number}) =>
  Math.round(row.qty_sold*1000)-Math.round(row.qty_returned*1000)===Math.round(row.qty_net*1000)
  && row.revenue-row.refund_total===row.net_revenue
const sellerSchema = z.object({id:z.string().min(1),name:z.string().min(1),...totals}).refine(consistent)
const rowsSchema = z.array(z.object({
  product_id:z.string().min(1),sku:z.string(),barcode:z.string().nullable(),name:z.string().min(1),
  unit:z.string(),qty_on_hand:qty,storage_bin:z.string().nullable(),...totals,
  suppliers:z.array(z.object({id:z.string().min(1),name:z.string().min(1)})),
  sellers:z.array(sellerSchema).min(1),
}).refine(row => consistent(row)
  && new Set(row.sellers.map(s=>s.id)).size===row.sellers.length
  && new Set(row.suppliers.map(s=>s.id)).size===row.suppliers.length
  && Object.keys(totals).every(key=>{
    const field=key as keyof typeof totals, scale=key.startsWith('qty_')?1000:1
    return row.sellers.reduce((sum,s)=>sum+Math.round(s[field]*scale),0)===Math.round(row[field]*scale)
  }))).refine(rows=>new Set(rows.map(r=>r.product_id)).size===rows.length
    && ['revenue','refund_total','net_revenue'].every(key=>Number.isSafeInteger(rows.reduce((sum,r)=>sum+r[key as 'revenue'],0))))
export function parseSoldRows(value:unknown):SoldItem[]{
  const parsed=rowsSchema.safeParse(value)
  if(!parsed.success)throw Error('Звіт проданих товарів неповний або застарілий. Оновіть програму / сервер і перевірте резервну копію.')
  return parsed.data
}
export function soldSellerOptions(rows:SoldItem[]){
  const names=new Map<string,string>()
  for(const row of rows)for(const seller of row.sellers??[])names.set(seller.id,seller.name)
  return [...names].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name,'uk')||a.id.localeCompare(b.id))
}
export function soldSellerNames(row:SoldItem){return row.sellers?.map(s=>s.name).join(', ')||'Невідомий працівник'}
export function filterSoldRows(rows:SoldItem[],supplierId:string,sellerId:string,search:string){
  return filterSoldBySupplier(rows,supplierId).flatMap(row=>{
    if(!offlineProductMatchesQuery(row,search))return []
    if(!sellerId)return [row]
    const seller=row.sellers?.find(s=>s.id===sellerId)
    if(!seller)return []
    return [{...row,qty_sold:seller.qty_sold,qty_returned:seller.qty_returned,qty_net:seller.qty_net,
      revenue:seller.revenue,refund_total:seller.refund_total,net_revenue:seller.net_revenue,sellers:[seller]}]
  }).sort((a,b)=>b.qty_net-a.qty_net||a.name.localeCompare(b.name,'uk')||a.product_id.localeCompare(b.product_id))
}
export function soldTotals(rows:SoldItem[]){
  return {qty:rows.reduce((sum,r)=>sum+Math.round(r.qty_net*1000),0)/1000,
    revenue:rows.reduce((sum,r)=>sum+r.net_revenue,0)}
}
export function soldCopyText(rows:SoldItem[],heading:string){
  const total=soldTotals(rows)
  return heading+'\n'+rows.map((r,i)=>`${i+1}. ${r.name} | арт. ${r.sku||'—'} | код ${r.barcode||'—'} | продано ${r.qty_sold}, повернуто ${r.qty_returned}, чисто ${r.qty_net} ${r.unit} | сума ${(r.net_revenue/100).toFixed(2)} грн | залишок ${r.qty_on_hand} | ${soldSellerNames(r)} | ${soldSupplierNames(r)}`).join('\n')
    +`\nРазом: ${(total.revenue/100).toFixed(2)} грн\n${soldReportNote}`
}
