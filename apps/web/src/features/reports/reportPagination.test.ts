import { beforeEach,describe,expect,it,vi } from 'vitest'
const local=vi.hoisted(()=>({pos:{salesPeriodReport:vi.fn(),listSales:vi.fn()},orders:{listPaymentsByPeriod:vi.fn()}}))
const customers=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('@/lib/desktopBridge',()=>({desktopBridge:()=>local,isDesktopRuntime:()=>true}))
vi.mock('@/features/customers/customerApi',()=>({customerApi:customers}))
vi.mock('@/features/products/productApi',()=>({productApi:{list:vi.fn()}}))
vi.mock('@/features/inventory/warehouseApi',()=>({warehouseApi:{}}))
vi.mock('@/lib/api',()=>({api:{}}))
import { reportApi } from './reportApi'
function report(count:number){
 return {total_sales:count,total_revenue:count*100,returns_count:0,returns_total:0,net_revenue:count*100,profit:0,
  by_method:{cash:count*100,card:0,transfer:0,account:0,debt:0},payment_received_total:count*100,
  sales:Array.from({length:count},(_,i)=>({id:String(i),sale_number:String(i),status:'completed',total:100,payment_method:'cash',completed_at:'2026-09-09T12:00:00Z',customer:null})),
  daily:[{date:'2026-09-09',sales:count,revenue:count*100,gross_revenue:count*100,returns_total:0}]}
}
describe('complete local report snapshot',()=>{
 beforeEach(()=>vi.clearAllMocks())
 it('reads more than a page of receipts in one consistent local call',async()=>{
  local.pos.salesPeriodReport.mockResolvedValue(report(1205))
  expect((await reportApi.salesPeriod('2026-09-09','2026-09-09')).data.total_sales).toBe(1205)
  expect(local.pos.salesPeriodReport).toHaveBeenCalledTimes(1)
  expect(local.pos.listSales).not.toHaveBeenCalled()
 })
 it('rejects a partial snapshot instead of displaying partial totals',async()=>{
  local.pos.salesPeriodReport.mockResolvedValue({...report(2),sales:[]})
  await expect(reportApi.salesPeriod('2026-09-09','2026-09-09')).rejects.toThrow('неповний')
 })
 it('includes debtors beyond the first page',async()=>{
  customers.list.mockImplementation(async({page})=>({data:[{id:String(page),full_name:'Client',debt_balance:100}],pagination:{total_pages:2}}))
  expect((await reportApi.debtors()).data.map(row=>row.id)).toEqual(['1','2'])
 })
})
