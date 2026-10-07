import { beforeEach,afterEach,it,expect,vi } from 'vitest'
const state=vi.hoisted(()=>({desktop:false,bridge:null as any,get:vi.fn(),read:vi.fn()}))
vi.mock('@/lib/desktopBridge',()=>({isDesktopRuntime:()=>state.desktop,desktopBridge:()=>state.bridge}))
vi.mock('@/lib/api',()=>({api:{get:state.get}}))
vi.mock('@/features/customers/customerApi',()=>({customerApi:{}}))
vi.mock('@/features/products/productApi',()=>({productApi:{}}))
import { reportApi } from './reportApi'
import { parseWriteoffSummary,writeoffReportDate } from './writeoffReportData'
const month='2026-10'
const report=():any=>({month,count:1,total_cost:123,writeoffs:[{id:'w',reason:'loss',created_at:'2026-09-30T21:00:00Z',total_cost:123,items:[{id:'l',cost_kopecks:123}]}]})
beforeEach(()=>{
 vi.clearAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-30T21:30:00Z'))
 state.desktop=false;state.bridge=null;state.get.mockResolvedValue({data:report()});state.read.mockResolvedValue(report())
})
afterEach(()=>vi.useRealTimers())
it('validates the month, count, document costs and grand total',()=>expect(parseWriteoffSummary(report(),month).total_cost).toBe(123))
it('allows a true empty month',()=>expect(parseWriteoffSummary({month,count:0,total_cost:0,writeoffs:[]},month).count).toBe(0))
it.each(['month','count','total_cost','writeoffs'])('rejects old/missing field %s',key=>{
 const r=report();delete r[key];expect(()=>parseWriteoffSummary(r,month)).toThrow('неповний')
})
it.each([
 (r:any)=>r.month='2026-09',(r:any)=>r.count=2,(r:any)=>r.total_cost++,
 (r:any)=>r.writeoffs[0].total_cost++,(r:any)=>r.writeoffs[0].items=[],
 (r:any)=>r.writeoffs[0].items[0].cost_kopecks=null,
 (r:any)=>r.writeoffs[0].items[0].cost_kopecks='123',
 (r:any)=>r.writeoffs[0].items[0].cost_kopecks=-1,
 (r:any)=>r.writeoffs[0].items[0].cost_kopecks=1.5,
 (r:any)=>r.writeoffs[0].items[0].cost_kopecks=Infinity,
 (r:any)=>r.writeoffs[0].items.push({...r.writeoffs[0].items[0]}),
 (r:any)=>r.writeoffs.push({...r.writeoffs[0]}),
 (r:any)=>r.writeoffs[0].created_at='2026-10-31T22:00:00Z',
 (r:any)=>r.writeoffs[0].created_at='bad',
 (r:any)=>r.writeoffs[0].reason='unknown',
 (r:any)=>r.writeoffs[0].items[0].id='',
])('rejects inconsistent or corrupt report %#',mutate=>{
 const r=report();mutate(r);expect(()=>parseWriteoffSummary(r,month)).toThrow('неповний')
})
it('requests the Kyiv month and validates the single remote answer',async()=>{
 expect((await reportApi.writeoffsSummary()).data.total_cost).toBe(123)
 expect(state.get).toHaveBeenCalledExactlyOnceWith('/api/v1/reports/writeoffs/summary?month=2026-10',{silent:true})
})
it('reads the desktop summary once without per-document calls',async()=>{
 state.desktop=true;state.bridge={warehouse:{writeoffsSummary:state.read}}
 expect((await reportApi.writeoffsSummary()).data.total_cost).toBe(123)
 expect(state.read).toHaveBeenCalledExactlyOnceWith({month});expect(state.get).not.toHaveBeenCalled()
})
it.each([null,{warehouse:{}}])('never falls back to a stale server copy on missing local bridge',async bridge=>{
 state.desktop=true;state.bridge=bridge
 await expect(reportApi.writeoffsSummary()).rejects.toThrow('оновлена локальна');expect(state.get).not.toHaveBeenCalled()
})
it('propagates local failure instead of showing an empty or remote report',async()=>{
 state.desktop=true;state.bridge={warehouse:{writeoffsSummary:state.read}};state.read.mockRejectedValue(Error('local unavailable'))
 await expect(reportApi.writeoffsSummary()).rejects.toThrow('local unavailable');expect(state.get).not.toHaveBeenCalled()
})
it('rejects invalid server responses',async()=>{
 state.get.mockResolvedValue({data:{...report(),count:0}})
 await expect(reportApi.writeoffsSummary()).rejects.toThrow('неповний')
})
it('formats the same Kyiv calendar date for display and export',()=>{
 expect(writeoffReportDate('2026-09-30T21:00:00Z')).toBe('01.10.2026')
 expect(writeoffReportDate('2026-10-31T21:59:59Z')).toBe('31.10.2026')
})
