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
  it('25.11.2026: a different invoice total (supplier discount or a missing row) is a visible note, not a refusal', () => {
    const result=mergeAiInvoicePages([page(100,{invoice_total:250})])
    expect(result).not.toHaveProperty('invoice_total')
    expect(result.total_note).toContain('Підсумок накладної 250,00 грн, сума рядків 100,00 грн (різниця 150,00 грн)')
    expect(mergeAiInvoicePages([page(100,{invoice_total:90})]).total_note).toContain('можлива знижка постачальника')
  })
  // 27.11.2026, PDF власника (HOCO/Baseus, колонки «Сума, грн» і «Сума, $»): різні підсумки на сторінках більше не
  // скасовують розбір. Не підсумовуються і не беруться «перший-ліпший»: лише той, що дорівнює сумі рядків, або примітка.
  it('different document totals: the one equal to the goods is used, otherwise a visible note instead of a refusal', () => {
    const twoCurrencies = mergeAiInvoicePages([page(100,{invoice_total:250}),page(150,{invoice_total:5.34})])
    expect(twoCurrencies.products).toHaveLength(2)
    expect(twoCurrencies).toHaveProperty('invoice_total',250)
    expect(twoCurrencies.total_note).toContain('різні підсумки накладної: 250,00 грн, 5,34 грн')
    const neither = mergeAiInvoicePages([page(100,{invoice_total:260}),page(150,{invoice_total:240})])
    expect(neither.products).toHaveLength(2)
    expect(neither).not.toHaveProperty('invoice_total')
    expect(neither.total_note).toContain('Перевірте рядки й закупівлю')
  })
  it('checks page subtotals separately from the invoice total', () => {
    expect(mergeAiInvoicePages([page(100,{page_total:99}),page(150,{invoice_total:250})]).total_note).toContain('Фото 1: підсумок сторінки 99,00 грн')
  })
  it('25.11.2026: a last unnumbered photo whose total equals all goods so far is the invoice total, not its own page', () => {
    // Фото власника: два фото з товарами й третє — низ накладної з підсумком; ШІ назвав його «підсумком сторінки».
    const footerOnly = { products: [], page_total: 350 }
    expect(mergeAiInvoicePages([page(100), page(250), footerOnly]).products).toHaveLength(2)
    expect(mergeAiInvoicePages([page(100), page(150, { page_total: 250 })]).products).toHaveLength(2)
    // Підсумок не дорівнює ні сторінці, ні всім товарам — помітна примітка (знижка чи пропущений рядок), а не відмова.
    expect(mergeAiInvoicePages([page(100), page(250), { products: [], page_total: 400 }]).total_note).toContain('Фото 3: підсумок сторінки 400,00 грн')
    // Пронумеровані сторінки перевіряються строго, як і раніше.
    expect(() => mergeAiInvoicePages([page(100, { page_number: 1 }), page(150, { page_number: 2, page_total: 250 })])).toThrow('підсумок сторінки')
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
    expect(mergeAiInvoicePages([page(100),{products:[],invoice_total:200}]).total_note).toContain('Підсумок накладної 200,00 грн')
    expect(()=>mergeAiInvoicePages([{products:[],invoice_total:0}])).toThrow('Відсутня таблиця')
  })
  it.each([true,{},[],'1e3',-1,'wrong',1.001])('rejects invalid total %j instead of ignoring it', invoice_total => {
    expect(()=>mergeAiInvoicePages([page(100,{invoice_total})])).toThrow('сума')
  })
  it('allows explicit zero without treating it as missing and rounds each line, not the grand product', () => {
    expect(mergeAiInvoicePages([page(0,{page_total:0,invoice_total:0})])).toHaveProperty('invoice_total',0)
    const product={...row(1.01),qty:1.5,line_total:1.52}
    expect(mergeAiInvoicePages([{products:[product,product],invoice_total:'3,04'}])).toHaveProperty('invoice_total',3.04)
    expect(mergeAiInvoicePages([{products:[product,product],invoice_total:3.03}]).total_note).toContain('Підсумок накладної 3,03 грн')
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
  it('25.11.2026: whole-document discounts/VAT keep line prices as printed and are flagged for the person', () => {
    const discount=mergeAiInvoicePages([page(100,{invoice_total:90})])
    expect(discount.products[0].purchase_price_uah).toBe(100)
    expect(discount.total_note).toContain('можлива знижка постачальника')
    const vat=mergeAiInvoicePages([page(100,{invoice_total:120})])
    expect(vat.products[0].purchase_price_uah).toBe(100)
    expect(vat.total_note).toContain('різниця 20,00 грн')
    expect(vat.total_note).not.toContain('знижка постачальника')
  })
})
