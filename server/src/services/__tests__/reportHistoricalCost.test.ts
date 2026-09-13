import { it, expect, vi } from 'vitest'
vi.mock('../../db/supabase.js', () => ({ db: { from: vi.fn() } }))
import { db } from '../../db/supabase.js'
import { getSalesPeriod } from '../reportService.js'
it('uses captured cost, discounted sale total and dated refunds, not current product cost', async () => {
  const tables: Record<string, any[]> = {
    sales: [{id:'sale',total:18000,payment_method:'cash'}],
    sale_items: [{id:'line',sale_id:'sale',qty:2,cost_price:5000,unit_price:10000,discount:0}],
    returns: [{id:'return'}], return_items: [{id:'returned-line',quantity:1,total_kopecks:9000,sale_item:{cost_price:5000}}],
    customer_orders: [], order_payments: [],
  }
  vi.mocked(db.from).mockImplementation(((table: string) => {
    let start=0,end=499
    const query: any = {
      select: (fields: string) => {expect(fields).not.toContain('purchase_price');return query},
      eq:()=>query,gte:()=>query,lte:()=>query,in:()=>query,order:()=>query,
      range:(a:number,b:number)=>{start=a;end=b;return query},
      then:(resolve:any)=>resolve({data:(tables[table]??[]).slice(start,end+1),error:null}),
    }; return query
  }) as any)
  const report=await getSalesPeriod({from:'2026-09-13',to:'2026-09-13'},'tenant')
  expect(report.profit).toBe(4000)
  expect(report.total_revenue).toBe(18000)
  expect(vi.mocked(db.from).mock.calls.some(([name])=>name==='products')).toBe(false)
})
