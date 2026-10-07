import { describe, expect, it } from 'vitest'
import { mergeAiInvoicePages } from './aiInvoiceResponse.js'

const row = (amount = 100) => ({ name: 'Фільтр', qty: 1, purchase_price_uah: amount })
const page = (amount = 100, extra: Record<string, unknown> = {}) => ({ products: [row(amount)], ...extra })

describe('printed photo invoice totals and page completeness', () => {
  it('checks the owner invoice: six lines, 19 214 UAH, not the repeated footer twice', () => {
    const products = [[4,1455],[20,14],[20,18],[4,1860],[2,1782],[1,1750]]
      .map(([qty,purchase_price_uah])=>({...row(),qty,purchase_price_uah}))
    const result=mergeAiInvoicePages([{products:products.slice(0,3),page_number:1,page_count:2,page_total:6460,invoice_total:19214},
      {products:products.slice(3),page_number:2,page_count:2,page_total:12754,invoice_total:19214}])
    expect(result.products).toHaveLength(6)
    expect(result).toHaveProperty('invoice_total',19214)
  })
  it('rejects a missing row even when every surviving row total is correct', () => {
    expect(()=>mergeAiInvoicePages([page(100,{invoice_total:250})])).toThrow('підсумок накладної')
  })
  it('rejects different document totals instead of summing or choosing the first', () => {
    expect(()=>mergeAiInvoicePages([page(100,{invoice_total:250}),page(150,{invoice_total:240})])).toThrow('різні підсумки')
  })
  it('checks page subtotals separately from the invoice total', () => {
    expect(()=>mergeAiInvoicePages([page(100,{page_total:99}),page(150,{invoice_total:250})])).toThrow('підсумок сторінки')
  })
  it('checks cumulative totals in printed page order without changing source row order', () => {
    const result=mergeAiInvoicePages([page(150,{page_number:2,page_count:2,brought_forward_total:100,carried_forward_total:250,invoice_total:250}),
      page(100,{page_number:1,page_count:2,page_total:100,carried_forward_total:100})])
    expect(result.products.map(p=>p.purchase_price_uah)).toEqual([150,100])
  })
  it.each(['brought_forward_total','carried_forward_total'])('does not ignore a wrong %s', key => {
    expect(()=>mergeAiInvoicePages([page(100,{page_number:1}),page(150,{page_number:2,[key]:999})])).toThrow('перенесена сума')
  })
  it('does not guess page order for cumulative totals when photos have no printed numbers', () => {
    expect(()=>mergeAiInvoicePages([page(100),page(150,{carried_forward_total:250})])).toThrow('порядок сторінок')
  })
  it('accepts two complementary crops of a numbered page, preserving repeated real goods', () => {
    expect(mergeAiInvoicePages([page(100,{page_number:1,page_count:1}),page(100,{page_number:1,page_count:1,page_total:200,invoice_total:200})]).products).toHaveLength(2)
  })
  it('detects duplicate numbered pages when their printed total is present', () => {
    expect(()=>mergeAiInvoicePages([page(100,{page_number:1,page_total:100}),page(100,{page_number:1,page_total:100})])).toThrow('підсумок сторінки')
  })
  it('accepts a separate footer photo only after checking the entire document', () => {
    expect(mergeAiInvoicePages([page(100),{products:[],invoice_total:100}]).products).toHaveLength(1)
    expect(()=>mergeAiInvoicePages([page(100),{products:[],invoice_total:200}])).toThrow('підсумок накладної')
    expect(()=>mergeAiInvoicePages([{products:[],invoice_total:0}])).toThrow('Відсутня таблиця')
  })
  it.each([true,{},[],'1e3',-1,'wrong',1.001])('rejects invalid total %j instead of ignoring it', invoice_total => {
    expect(()=>mergeAiInvoicePages([page(100,{invoice_total})])).toThrow('сума')
  })
  it('allows explicit zero without treating it as missing and rounds each line, not the grand product', () => {
    expect(mergeAiInvoicePages([page(0,{page_total:0,invoice_total:0})])).toHaveProperty('invoice_total',0)
    const product={...row(1.01),qty:1.5,line_total:1.52}
    expect(mergeAiInvoicePages([{products:[product,product],invoice_total:'3,04'}])).toHaveProperty('invoice_total',3.04)
    expect(()=>mergeAiInvoicePages([{products:[product,product],invoice_total:3.03}])).toThrow('підсумок накладної')
  })
  it.each([
    [page(100,{page_number:1,page_count:2})],
    [page(100,{page_number:2,page_count:2})],
    [page(100,{page_number:1}),page(100,{page_number:3})],
    [page(100,{page_number:1,page_count:2}),page(100,{page_number:2,page_count:3})],
    [page(100,{page_number:1,page_count:2}),page(100)],
  ].map(pages=>({pages})))('rejects incomplete or conflicting printed pagination: %j', ({pages}) => {
    expect(()=>mergeAiInvoicePages(pages)).toThrow('сторін')
  })
  it.each([0,-1,1.5,true,'2',10001])('rejects invalid page number %j', page_number => {
    expect(()=>mergeAiInvoicePages([page(100,{page_number})])).toThrow('сторін')
  })
  it('does not count an unnumbered final-total crop as an extra numbered page', () => {
    const result=mergeAiInvoicePages([page(100,{page_number:1,page_count:2}),
      page(150,{page_number:2,page_count:2}),{products:[],invoice_total:250}])
    expect(result.products).toHaveLength(2)
    expect(result.invoice_total).toBe(250)
  })
  it('still requires numbered zero-price goods pages, even though their sum is zero', () => {
    expect(()=>mergeAiInvoicePages([page(100,{page_number:1,page_count:2}),page(0,{invoice_total:100})])).toThrow('сторін')
  })
  it('does not claim unprinted totals or page counts were verified', () => {
    const result=mergeAiInvoicePages([page(),page()])
    expect(result.products).toHaveLength(2)
    expect(result).not.toHaveProperty('invoice_total')
  })
  it('rejects whole-document discounts/VAT mismatches rather than altering line prices', () => {
    expect(()=>mergeAiInvoicePages([page(100,{invoice_total:90})])).toThrow('ПДВ')
    expect(()=>mergeAiInvoicePages([page(100,{invoice_total:120})])).toThrow('ПДВ')
  })
})
