import { describe, expect, it } from 'vitest'
import { parseAiJsonObject, mergeAiInvoicePages } from './aiInvoiceResponse.js'

describe('photo invoice integrity', () => {
  const product = { name: 'Мастило', qty: 1.5, purchase_price_uah: 1.01, line_total: 1.52, sku: '0001' }
  it('preserves fractional quantities, explicit zero prices, repeated valid rows and leading zeros', () => {
    const parsed = mergeAiInvoicePages([{invoice_number:'A',products:[product,{...product,purchase_price_uah:0,line_total:0}]},{invoice_number:'A',products:[product]}])
    expect(parsed.products).toHaveLength(3)
    expect(parsed.products[0]).toMatchObject(product)
    expect(parsed.products[1].purchase_price_uah).toBe(0)
    expect(parsed.products[0]).not.toHaveProperty('unit')
  })
  it.each([true,[],{},'1e3','1 2','1.2345',-1,0,1_000_001])('rejects invalid quantity %j', qty => {
    expect(()=>mergeAiInvoicePages([{products:[{...product,qty}]}])).toThrow('кількість')
  })
  it.each([true,[],{},'1e3','1 20','120 грн','1.001',-1,21_474_836.48])('rejects invalid price %j', purchase_price_uah => {
    expect(()=>mergeAiInvoicePages([{products:[{...product,purchase_price_uah}]}])).toThrow('цін')
  })
  it.each(['USD','EUR','GBP',{},1])('rejects foreign or invalid photo currency %j instead of guessing a rate', currency => {
    expect(()=>mergeAiInvoicePages([{currency,products:[product]}])).toThrow('валюта')
    expect(()=>mergeAiInvoicePages([{products:[{...product,currency}]}])).toThrow('валюта')
  })
  it('accepts an explicit UAH photo without inventing a conversion', () => {
    expect(mergeAiInvoicePages([{currency:'UAH',products:[product]}]).products[0].purchase_price_uah).toBe(1.01)
  })
  it('does not ignore inconsistent line totals or wrong metadata types', () => {
    expect(()=>mergeAiInvoicePages([{products:[{...product,line_total:1.51}]}])).toThrow('сумою рядка')
    expect(()=>mergeAiInvoicePages([{products:[{...product,barcode:123}]}])).toThrow('текстове поле')
    expect(()=>mergeAiInvoicePages([{products:[product],supplier_name:[]}])).toThrow('реквізити')
    expect(()=>mergeAiInvoicePages([{products:[product],supplier_name:'Перший'},{products:[product],supplier_name:'Другий'}])).toThrow('різні постачальники')
  })
  it('caps the whole document at 2000 rows without truncating pages', () => {
    expect(mergeAiInvoicePages([{products:Array.from({length:1000},()=>product)},{products:Array.from({length:1000},()=>product)}]).products).toHaveLength(2000)
    expect(()=>mergeAiInvoicePages([{products:Array.from({length:2001},()=>product)}])).toThrow('2000')
  })
})

describe('parseAiJsonObject', () => {
  it('parses a normal structured response', () => {
    expect(parseAiJsonObject('{"products":[{"name":"Фільтр"}]}')).toEqual({
      products: [{ name: 'Фільтр' }],
    })
  })

  it('recovers JSON wrapped in markdown or explanatory text', () => {
    expect(parseAiJsonObject('```json\n{"products":[{"name":"Олива"}]}\n```')).toEqual({
      products: [{ name: 'Олива' }],
    })
    expect(parseAiJsonObject('Ось таблиця: {"products":[{"name":"Лампа"}]} готово')).toEqual({
      products: [{ name: 'Лампа' }],
    })
  })

  it('rejects empty and truncated responses instead of inventing rows', () => {
    expect(parseAiJsonObject('')).toBeNull()
    expect(parseAiJsonObject('{"products":[{"name":"Незавершено"}')).toBeNull()
  })
})
