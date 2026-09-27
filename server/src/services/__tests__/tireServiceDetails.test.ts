import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ fail:false, queries:[] as Array<{sql:string;params:unknown[]}> }))
vi.mock('../../db/supabase.js',()=>({db:{}}))
vi.mock('../../db/supabaseAdmin.js',()=>({supabaseAdmin:{}}))
vi.mock('../../middleware/auth.js',()=>({requireAuth:vi.fn(),requireRole:()=>vi.fn()}))
vi.mock('../adminService.js',()=>({listUsers:async()=>[
  {id:'worker',role:'tire_worker',is_active:true,full_name:'Андрій',base_rate:0,rate_period:'day'},
  {id:'cashier',role:'cashier',is_active:true,full_name:'Никита'},
]}))
vi.mock('../../db/pg.js',()=>({runTransaction:vi.fn(),pool:{query:async(sql:string,params:unknown[])=>{
  state.queries.push({sql,params})
  if(sql.includes('FROM salary_payments p') && sql.includes('SUM(')) return {rows:[{employee_id:'worker',earned:'12600',paid:'10000',penalty:'0',commission_earned:'12600',daily_rate:'0'}]}
  if(sql.includes('WITH service_sales')) return {rows:[{id:'sale',sale_number:'TIRE-47',completed_at:'2026-09-22T13:40:00Z',employee_id:'worker',payment_method:'cash',total:36000,services_qty:2,service_revenue:'36000',cash_revenue:'36000',cashier_id:'cashier',notes:'R16',services:[{id:'line',description:'Балансування',qty:2,unit_price:18000,total:36000}]}]}
  if(sql.includes('FROM salary_payments p')) return {rows:[{id:'commission',employee_id:'worker',type:'bonus',source:'commission',amount:'12600',sale_id:'sale',created_by:'cashier',created_at:'2026-09-22T13:40:00Z',work_date:'2026-09-22'}]}
  if(sql.includes('SUM(amount)')) return {rows:[{employee_id:'worker',amount:'36000'}]}
  if(state.fail) throw new Error('Report details unavailable')
  return {rows:[{id:'handover',employee_id:'worker',amount:'36000',work_date:'2026-09-22',created_at:'2026-09-25T07:00:00Z',created_by:'cashier',note:'За роботи 22 вересня'}]}
}}}))
import router from '../../routes/salary.js'
const handler=(router as any).stack.find((layer:any)=>layer.route?.path==='/tire-service-report').route.stack.at(-1).handle
beforeEach(()=>{state.fail=false;state.queries=[]})
async function request(){const json=vi.fn(),next=vi.fn();await handler({query:{date:'2026-09-22'},user:{tenant_id:'shop'}},{json},next);return{json,next}}
it('returns cashier, work, notes and actual operation dates with saved commissions',async()=>{
  const {json,next}=await request();expect(next).not.toHaveBeenCalled()
  const report=json.mock.calls[0][0]
  expect(report.details_version).toBe(1)
  expect(report.receipts[0]).toMatchObject({cashier_name:'Никита',notes:'R16',commission_earned:12600})
  expect(report.salary_operations[0]).toMatchObject({amount:12600,cashier_name:'Никита'})
  expect(report.cash_handovers[0]).toMatchObject({amount:36000,cashier_name:'Никита',created_at:'2026-09-25T07:00:00Z'})
  expect(report.data[0]).toMatchObject({earned:12600,paid:10000,due:2600,cash_pending:0})
})
it('scopes all five reads by tenant and work date, excludes deleted records and uses the server cashier column',async()=>{
  await request();expect(state.queries).toHaveLength(5)
  for(const {sql,params} of state.queries){expect(params.slice(0,2)).toEqual(['shop','2026-09-22']);expect(sql).toContain('deleted_at')}
  const receipts=state.queries.find(q=>q.sql.includes('WITH service_sales'))!
  expect(receipts.params[2]).toEqual(['worker']);expect(receipts.sql).toContain("COALESCE(NULLIF(item.sku, ''), product.sku, '')")
  const cash=state.queries.at(-1)!.sql;expect(cash).toContain('c.created_by');expect(cash).not.toContain('c.user_id')
})
it('fails the entire report instead of silently showing missing operations as zeros',async()=>{
  state.fail=true;const {json,next}=await request();expect(json).not.toHaveBeenCalled();expect(next.mock.calls[0][0].message).toBe('Report details unavailable')
})
