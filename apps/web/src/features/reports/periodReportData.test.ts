import { beforeEach,afterEach,it,expect,vi } from 'vitest'
const state=vi.hoisted(()=>({desktop:false,bridge:null as any,read:vi.fn(),get:vi.fn()}))
vi.mock('@/lib/desktopBridge',()=>({isDesktopRuntime:()=>state.desktop,desktopBridge:()=>state.bridge}))
vi.mock('@/lib/api',()=>({api:{get:state.get}}))
vi.mock('@/features/customers/customerApi',()=>({customerApi:{}}))
vi.mock('@/features/products/productApi',()=>({productApi:{}}))
vi.mock('@/features/inventory/warehouseApi',()=>({warehouseApi:{}}))
import { parsePeriodReport,periodReportNote } from './periodReportData'
import { reportApi } from './reportApi'
const day='2026-10-04'
function report():any{return {
 total_sales:1,total_revenue:10000,returns_count:1,returns_total:4000,net_revenue:6000,profit:2400,payment_received_total:10000,
 by_method:{cash:4000,card:0,transfer:6000,account:0,debt:0},
 sales:[{id:'s',sale_number:'S',total:10000,payment_method:'mixed',status:'returned',completed_at:day+'T10:00:00Z',customer:null}],
 daily:[{date:day,sales:1,gross_revenue:10000,returns_total:4000,revenue:6000}],
}}
beforeEach(()=>{vi.clearAllMocks();state.desktop=false;state.bridge=null;state.get.mockResolvedValue({data:report()});state.read.mockResolvedValue(report())})
afterEach(()=>vi.useRealTimers())
it('validates gross, returns, net and receipts as distinct consistent values',()=>expect(parsePeriodReport(report()).net_revenue).toBe(6000))
it('allows a negative return-only day',()=>{
 const r=report();Object.assign(r,{total_sales:0,total_revenue:0,net_revenue:-4000,sales:[]})
 Object.assign(r.daily[0],{sales:0,gross_revenue:0,revenue:-4000})
 expect(parsePeriodReport(r).net_revenue).toBe(-4000)
})
it.each(['total_sales','total_revenue','returns_count','returns_total','net_revenue','payment_received_total','profit','daily'])('rejects an old response missing %s',key=>{
 const r=report();delete r[key];expect(()=>parsePeriodReport(r)).toThrow('неповний')
})
it.each([
 (r:any)=>r.net_revenue++,
 (r:any)=>r.sales=[],
 (r:any)=>r.by_method.transfer++,
 (r:any)=>r.daily.push({...r.daily[0]}),
 (r:any)=>r.sales.push({...r.sales[0]}),
 (r:any)=>r.daily[0].revenue++,
 (r:any)=>r.by_method.cash=-1,
 (r:any)=>r.returns_total=.5,
 (r:any)=>r.profit=Infinity,
])('rejects inconsistent totals and unsafe values %#',mutate=>{
 const r=report();mutate(r);expect(()=>parsePeriodReport(r)).toThrow('неповний')
})
it('uses exactly one local snapshot and the Kyiv day bounds',async()=>{
 state.desktop=true;state.bridge={pos:{salesPeriodReport:state.read}}
 expect((await reportApi.salesPeriod(day,day)).data.net_revenue).toBe(6000)
 expect(state.read).toHaveBeenCalledWith({date_from:'2026-10-03T21:00:00.000Z',date_to:'2026-10-04T20:59:59.999Z'})
 expect(state.get).not.toHaveBeenCalled()
})
it.each([null,{pos:{}}])('does not fall back to server if desktop bridge is missing/old',async bridge=>{
 state.desktop=true;state.bridge=bridge
 await expect(reportApi.salesPeriod(day,day)).rejects.toThrow('оновлена локальна')
 expect(state.get).not.toHaveBeenCalled()
})
it('propagates local failure and keeps the server untouched',async()=>{
 state.desktop=true;state.bridge={pos:{salesPeriodReport:state.read}};state.read.mockRejectedValue(Error('unavailable'))
 await expect(reportApi.salesPeriod(day,day)).rejects.toThrow('unavailable');expect(state.get).not.toHaveBeenCalled()
})
it('validates the remote snapshot instead of trusting typed JSON',async()=>{
 state.get.mockResolvedValue({data:{...report(),sales:[]}})
 await expect(reportApi.salesPeriod(day,day)).rejects.toThrow('неповний')
})
it.each([['2026-02-30',day],[day,'2026-10-03'],['',day]])('rejects invalid/reversed range %s..%s before reading',async(from,to)=>{
 await expect(reportApi.salesPeriod(from,to)).rejects.toThrow('період')
 expect(state.get).not.toHaveBeenCalled();expect(state.read).not.toHaveBeenCalled()
})
it('reads a weekly snapshot once and fills only truly empty days with zero',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(day+'T10:00:00Z'))
 const {data}=await reportApi.weekly()
 expect(state.get).toHaveBeenCalledTimes(1);expect(data).toHaveLength(7)
 expect(data.at(-1)).toMatchObject({revenue:6000,gross_revenue:10000,returns_total:4000})
 expect(data[0].revenue).toBe(0)
})
it('daily summary uses the same validated period result',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(day+'T10:00:00Z'))
 expect((await reportApi.salesToday()).data).toMatchObject({net_revenue:6000,returns_total:4000,payment_received_total:10000})
 expect(state.get).toHaveBeenCalledTimes(1)
})
it.each([
 (r:any)=>r.daily[0].date='2026-02-30',
 (r:any)=>r.daily[0].date='2026-10-03',
 (r:any)=>r.sales[0].completed_at='2026-10-03T10:00:00Z',
 (r:any)=>r.sales[0].payment_method='unknown',
 (r:any)=>r.returns_count=0,
])('rejects an impossible/misdated or unsupported response %#',mutate=>{
 const r=report();mutate(r);expect(()=>parsePeriodReport(r,day,day)).toThrow('неповний')
})
it('checks requested range even if all response dates agree with each other',async()=>{
 const r=report();r.daily[0].date='2026-10-03';r.sales[0].completed_at='2026-10-03T10:00:00Z';state.get.mockResolvedValue({data:r})
 await expect(reportApi.salesPeriod(day,day)).rejects.toThrow('неповний')
})
it('assigns receipts around UTC midnight to their actual Kyiv date',()=>{
 const r=report();r.sales[0].completed_at='2026-10-03T22:00:00Z'
 expect(parsePeriodReport(r,day,day).total_sales).toBe(1)
})
it('explains that accepted payments are gross and account money is not new cash',()=>{
 expect(periodReportNote).toContain('до віднімання повернень')
 expect(periodReportNote).toContain('не є новою готівкою')
})
