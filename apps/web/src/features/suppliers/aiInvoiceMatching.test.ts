import { describe, expect, it } from 'vitest'
import { aiRowsToInvoiceItems, applyInvoiceMatch, bindInvoiceCandidate, invoiceMatchInput, invoiceMatchProblems, type InvoiceMatch } from './aiInvoiceMatching'
const candidate = {id:'ours',name:'Наш резонатор Тернопіль',sku:'38490',barcode:'2000999999999',brand:null,unit:'шт',retail_price:90000,category_id:'exhaust'}
const matched: InvoiceMatch = { status:'matched',source_name:'Резонатор 2101 Тернополь',name:candidate.name,brand:'',product_id:'ours',candidates:[candidate],reason:'Точний збіг',validation_errors:[] }
const raw = {name:'Резонатор 2101 Тернополь',sku:'44',qty:1,purchase_price_uah:605,unit:'шт',match_choice:'new'}
describe('AI rows inside the ordinary invoice', () => {
  it('automatically uses a known card despite a stale new choice; preserves invoice money and quantity', () => {
    const [item] = aiRowsToInvoiceItems([raw],[matched],[],{})
    expect(item).toMatchObject({product_id:'ours',sku:'38490',barcode:candidate.barcode,qty:1,purchase_price:60500,total:60500,is_new:false,ai_review:{choice:'ours'}})
    expect(invoiceMatchProblems(item)).toEqual([])
    expect(invoiceMatchInput({...item,qty:8,purchase_price:60000})).toMatchObject({qty:8,purchase_price_uah:600,match_choice:'ours'})
  })
  it('keeps ambiguous rows editable and red, without manufacturing a new card or barcode', () => {
    const review = {...matched,status:'review' as const,product_id:null,reason:'Дві картки',candidates:[candidate,{...candidate,id:'other'}]}
    const [item] = aiRowsToInvoiceItems([{...raw,match_choice:''}],[review],[],{})
    expect(item.product_id).toBeUndefined(); expect(item.barcode).toBe('')
    expect(invoiceMatchProblems(item)).toEqual(['Дві картки'])
    const bound = bindInvoiceCandidate(item,candidate)
    expect(bound).toMatchObject({qty:1,purchase_price:60500,product_id:'ours'})
    expect(invoiceMatchProblems(bound)).toEqual([])
  })
  it('retains unit mismatch and zero purchase value after matching or scanning', () => {
    const [item] = aiRowsToInvoiceItems([{...raw,unit:'компл',purchase_price_uah:0}],[{...matched,validation_errors:['Уточніть одиницю']}],[],{})
    expect(bindInvoiceCandidate(item,candidate)).toMatchObject({purchase_price:0,unit:'компл'})
    expect(invoiceMatchProblems(item)).toEqual(['Уточніть одиницю'])
  })
  it('keeps current card edits when refreshing validation and lets a human choose another card', () => {
    const [item] = aiRowsToInvoiceItems([raw],[matched],[],{})
    expect(applyInvoiceMatch({...item,product_name:'Виправлена назва'},matched).product_name).toBe('Виправлена назва')
    const other = {...candidate,id:'other'}
    const result = applyInvoiceMatch({...item,product_id:'other',ai_review:{...item.ai_review!,choice:'other'}},{...matched,candidates:[candidate,other]})
    expect(result.product_id).toBe('other')
  })
  it('uses the actual matched card category for the configured markup', () => {
    const [item] = aiRowsToInvoiceItems([{...raw,category_name:'Шини'}],[matched],[{id:'tires',name:'Шини'}],{category_markups:[{category_id:'exhaust',markup_pct:50},{category_id:'tires',markup_pct:10}]})
    expect(item).toMatchObject({category_id:'exhaust',retail_price:90800})
  })
  it('keeps all 2000 rows and proposed new category without writes', () => {
    const review = {...matched,status:'new' as const,product_id:null,candidates:[]}
    const items=aiRowsToInvoiceItems(Array.from({length:2000},(_,i)=>({...raw,sku:'N-'+i,qty:i+1,category_name:'Нова папка'})),Array(2000).fill(review),[],{markup_rules:[{minPrice:0,maxPrice:999999,markupPct:50}]})
    expect(items).toHaveLength(2000); expect(items[1999]).toMatchObject({qty:2000,ai_category_name:'Нова папка',retail_price:90800})
    expect(new Set(items.map(item=>item.client_key)).size).toBe(2000)
  })
})
