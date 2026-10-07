import { z } from 'zod'
import type { SalesPeriodReport } from '@/types/report'
import { businessDateKey } from '@/lib/businessDate'
import { validStaffRange } from '@/features/analytics/staffData'
const money=z.number().int().refine(Number.isSafeInteger)
const positive=money.refine(n=>n>=0)
const day=z.object({date:z.string().refine(value=>validStaffRange(value,value)),sales:positive,revenue:money,gross_revenue:positive,returns_total:positive})
  .refine(r=>r.gross_revenue-r.returns_total===r.revenue)
const schema=z.object({
  total_sales:positive,total_revenue:positive,returns_count:positive,returns_total:positive,net_revenue:money,
  payment_received_total:positive,profit:money,
  by_method:z.object({cash:positive,card:positive,transfer:positive,account:positive,debt:positive}),
  sales:z.array(z.object({id:z.string().min(1),sale_number:z.string(),total:positive,payment_method:z.enum(['cash','card','transfer','account','mixed','debt']),
    status:z.enum(['completed','returned']),completed_at:z.string().datetime({offset:true}),
    customer:z.object({id:z.string(),phone:z.string(),full_name:z.string().nullable()}).nullable()})),
  daily:z.array(day),
}).refine(r => r.total_revenue-r.returns_total===r.net_revenue
  && r.total_sales===r.sales.length && new Set(r.sales.map(s=>s.id)).size===r.sales.length
  && r.sales.reduce((a,s)=>a+s.total,0)===r.total_revenue
  && r.by_method.cash+r.by_method.card+r.by_method.transfer+r.by_method.account===r.payment_received_total
  && new Set(r.daily.map(d=>d.date)).size===r.daily.length
  && r.daily.reduce((a,d)=>a+d.revenue,0)===r.net_revenue
  && r.daily.reduce((a,d)=>a+d.gross_revenue,0)===r.total_revenue
  && r.daily.reduce((a,d)=>a+d.returns_total,0)===r.returns_total
  && r.daily.reduce((a,d)=>a+d.sales,0)===r.total_sales)
export function parsePeriodReport(value:unknown,from?:string,to=from):SalesPeriodReport {
  const parsed=schema.safeParse(value)
  const invalid=()=>{throw Error('Фінансовий звіт неповний або застарілий. Оновіть програму / сервер і перевірте резервну копію.')}
  if(!parsed.success)return invalid()
  const report=parsed.data
  if(report.returns_count===0 && report.returns_total!==0)return invalid()
  if(from!==undefined && (!to || !validStaffRange(from,to)
    || report.daily.some(d=>d.date<from || d.date>to)))return invalid()
  const receiptsByDay=new Map<string,{count:number;total:number}>()
  for(const receipt of report.sales){
    const date=businessDateKey(receipt.completed_at)
    const row=receiptsByDay.get(date)??{count:0,total:0}
    row.count++;row.total+=receipt.total;receiptsByDay.set(date,row)
  }
  if([...receiptsByDay].some(([date,row])=>!report.daily.some(d=>d.date===date && d.sales===row.count && d.gross_revenue===row.total)))return invalid()
  return report
}
export const periodReportNote='Продажі й повернення показані за власною датою. Отримані платежі — до віднімання повернень; кошти з рахунку клієнта не є новою готівкою. Залишок у касі звіряйте у закритті зміни.'
