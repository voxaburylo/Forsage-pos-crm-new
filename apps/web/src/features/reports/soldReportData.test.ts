import {describe,it,expect} from 'vitest'
import * as XLSX from 'xlsx'
import {parseSoldRows,filterSoldRows,soldTotals,soldSellerOptions,soldCopyText,validSoldRange} from './soldReportData'
import {soldReorderExport,UNKNOWN_SUPPLIER} from './soldSupplierReport'
const totals={qty_sold:3,qty_returned:1,qty_net:2,revenue:30000,refund_total:10000,net_revenue:20000}
const row={product_id:'p',name:'Фільтр WIX WA9428',sku:'WA9428',barcode:'0200000000001',unit:'шт',
 qty_on_hand:3,storage_bin:null,...totals,suppliers:[{id:'a',name:'Автокомфорт'},{id:'b',name:'Інший'}],
 sellers:[{id:'one',name:'Перший',...totals,qty_sold:1,qty_returned:0,qty_net:1,revenue:10000,refund_total:0,net_revenue:10000},
 {id:'two',name:'Другий',...totals,qty_sold:2,qty_net:1,revenue:20000,net_revenue:10000}]}
describe('sold report validity and one filtered dataset',()=>{
 it('preserves all columns without changing the input',()=>{
  const input=structuredClone(row);expect(parseSoldRows([input])).toEqual([row]);expect(input).toEqual(row)
 })
 it('accepts a return-only period with negative totals',()=>{
  const negative={...row,qty_sold:0,qty_returned:1,qty_net:-1,revenue:0,refund_total:10000,net_revenue:-10000}
  negative.sellers=[{id:'one',name:'Перший',qty_sold:0,qty_returned:1,qty_net:-1,revenue:0,refund_total:10000,net_revenue:-10000}]
  expect(soldTotals(parseSoldRows([negative]))).toEqual({qty:-1,revenue:-10000})
 })
 it.each([
  ['name',''],['qty_sold',NaN],['qty_net',3],['revenue',.5],['net_revenue',0],['refund_total',Infinity],
  ['suppliers',undefined],['sellers',undefined],['sellers',[]],['sellers',[row.sellers[0],row.sellers[0]]],
  ['qty_on_hand',.0001],
 ])('rejects malformed or legacy field %s', (key,value)=>{
  expect(()=>parseSoldRows([{...row,[key]:value}])).toThrow('неповний')
 })
 it('rejects repeated product rows and truncated seller totals',()=>{
  expect(()=>parseSoldRows([row,row])).toThrow()
  expect(()=>parseSoldRows([{...row,sellers:[row.sellers[0]]}])).toThrow()
 })
 it.each(['2026-02-30','2026-13-01','2026-1-01','','9999-01-01'])('rejects invalid calendar %s',value=>{
  expect(validSoldRange(value,'2026-10-04')).toBe(false)
 })
 it('validates reversed and leap dates',()=>{
  expect(validSoldRange('2026-10-05','2026-10-04')).toBe(false)
  expect(validSoldRange('2024-02-29','2024-02-29')).toBe(true)
 })
 it.each(['фильтр','фільтр','WX WA9428','WA 9428','0200000000001'])('finds sold goods with catalog search rules: %s',query=>{
  expect(filterSoldRows([row],'','',query)).toHaveLength(1)
 })
 it.each(['WX WA9429','BO 1457434310','0200000000002'])('does not match an unrelated code: %s',query=>{
  expect(filterSoldRows([row],'','',query)).toEqual([])
 })
 it('combines supplier, seller and search; never shows other sellers money',()=>{
  const rows=filterSoldRows([row],'b','two','WX WA9428')
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({qty_sold:2,qty_returned:1,qty_net:1,revenue:20000,net_revenue:10000})
  expect(soldTotals(rows)).toEqual({qty:1,revenue:10000})
  expect(filterSoldRows([row],'absent','','')).toEqual([])
  expect(filterSoldRows([row],'','absent','')).toEqual([])
  expect(row.revenue).toBe(30000)
 })
 it('keeps supplier unknown explicit and lists sellers just once',()=>{
  expect(filterSoldRows([{...row,suppliers:[]}],UNKNOWN_SUPPLIER,'','')).toHaveLength(1)
  expect(soldSellerOptions([row,row])).toHaveLength(2)
 })
 it('exports/copies the same filtered totals, seller and identifiers as text',()=>{
  const rows=filterSoldRows([row],'a','two','фільтр')
  const exported=soldReorderExport(rows,'Автокомфорт')
  expect(exported[0]).toMatchObject({'Продано':2,'Повернуто':1,'Чисто продано':1,'Продавці':'Другий','Чиста сума (грн)':100,'Штрихкод':'0200000000001'})
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(exported),'Звіт')
  const opened=XLSX.read(XLSX.write(book,{type:'array',bookType:'xlsx'}),{type:'array'})
  expect(XLSX.utils.sheet_to_json(opened.Sheets['Звіт'])).toEqual(exported)
  const text=soldCopyText(rows,'2026-10-04 | Другий')
  expect(text).toContain('Разом: 100.00 грн');expect(text).toContain('0200000000001');expect(text).not.toContain('Перший')
 })
 it('sums fractional quantities without binary floating drift',()=>{
  const rows=Array.from({length:10},(_,i)=>({...row,product_id:''+i,qty_net:.1,net_revenue:1}))
  expect(soldTotals(rows)).toEqual({qty:1,revenue:10})
 })
})
