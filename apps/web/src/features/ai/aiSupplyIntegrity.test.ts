import { describe, expect, it } from 'vitest'
import { normalizeSupplyRows, parseSupplyText } from './aiSupplyImport'
import { assertSupplyLineTotal, readSupplyNumber } from './aiSupplyNumber'
const table=(qty:string, price:string, sum?:string)=>'Назва\tКількість\tЦіна'+(sum===undefined?'':'\tСума')+'\nКлюч\t'+qty+'\t'+price+(sum===undefined?'':'\t'+sum)
describe('Source quantities, prices and arithmetic integrity',()=>{
  it.each(['12 34','1 2','1\n2','1\t2','12 34,50','1 23 456'])('rejects accidental numeric glue %j',value=>{
    expect(()=>readSupplyNumber(value,'price','Тест')).toThrow()
  })
  it.each(['1 234,50','1\u00a0234,50','1\u202f234.50','1,234.50','1.234,50'])('preserves valid thousands %j',value=>{
    expect(parseSupplyText(table('1',value)).products[0].purchase_price_uah).toBe(1234.5)
  })
  it('keeps malformed table layout for full review rather than dropping extra values',()=>{
    expect(parseSupplyText(table('1','1\t2')).products).toEqual([])
    expect(parseSupplyText(table('1','1\n2')).products).toEqual([])
  })
  it('uses purchasing currency, not the retail column or product description',()=>{
    const parsed=parseSupplyText('Name\tQuantity\tPrice USD\tPrice retail UAH\nKey\t1\t10\t500')
    expect(parsed.sourceCurrency).toBe('USD')
    expect(parsed.products[0].purchase_price_uah).toBe(10)
    expect(parseSupplyText('Назва\tКількість\tЦіна\nКлюч USD\t1\t120').sourceCurrency).toBeUndefined()
    expect(parseSupplyText('Назва\tКількість\tЦіна\nКлюч\t1\t120 USD').sourceCurrency).toBe('USD')
  })
  it('rejects explicitly mixed UAH and foreign purchasing prices',()=>{
    expect(()=>parseSupplyText('Назва\tКількість\tЦіна\nКлюч\t1\t120 USD\nГайка\t1\t10 грн')).toThrow('кілька валют')
    expect(()=>parseSupplyText('Назва\tКількість\tЦіна UAH\nКлюч\t1\t120\nВсього USD\t\t')).toThrow('кілька валют')
  })
  it('accepts matching totals and exact rounding, rejects mismatches',()=>{
    expect(parseSupplyText(table('3','120,50','361,50')).products).toHaveLength(1)
    expect(parseSupplyText(table('1,5','1,01','1,52')).products).toHaveLength(1)
    expect(()=>parseSupplyText(table('98','10','560'))).toThrow('сумою рядка')
    expect(()=>assertSupplyLineTotal(1,120,'1 20','Тест')).toThrow('ціну')
  })
  it('checks foreign-currency totals in the same currency',()=>{
    expect(parseSupplyText(table('2','10 USD','20 USD')).sourceCurrency).toBe('USD')
    expect(()=>parseSupplyText(table('2','10 USD','20 грн'))).toThrow('кілька валют')
  })
  it('does not mistake a total column for purchasing price',()=>{
    expect(parseSupplyText('Назва\tКількість\tСума\nКлюч\t2\t240').products).toEqual([])
  })
  it.each(['Price retail','Price sale','Price sell'])('does not import %s as purchasing price',header=>{
    expect(parseSupplyText('Name\tQuantity\t'+header+'\nKey\t2\t240').products).toEqual([])
  })
  it('accepts equivalent numeric aliases but blocks disagreements',()=>{
    expect(normalizeSupplyRows([{name:'Ключ',qty:2,quantity:'2,000',purchase_price:120,cost_price:'120.00'}])[0].qty).toBe(2)
    expect(()=>normalizeSupplyRows([{name:'Ключ',qty:2,qty_on_hand:20,purchase_price:120}])).toThrow('суперечливі')
    expect(()=>normalizeSupplyRows([{name:'Ключ',qty:2,purchase_price:120,cost_price:240}])).toThrow('суперечливі')
  })
  it.each([true,[],{},['120']])('rejects non-scalar values %j',value=>{
    expect(()=>normalizeSupplyRows([{name:'Ключ',qty:value,purchase_price:120}])).toThrow()
    expect(()=>normalizeSupplyRows([{name:'Ключ',qty:1,purchase_price:value}])).toThrow()
    expect(()=>normalizeSupplyRows([{name:value,qty:1,purchase_price:120}])).toThrow()
  })
  it('does not turn malformed codes into object text or drop leading zeros',()=>{
    expect(()=>normalizeSupplyRows([{name:'Ключ',qty:1,purchase_price:120,barcode:{code:'001'}}])).toThrow('barcode')
    expect(normalizeSupplyRows([{name:'Ключ',qty:1,purchase_price:120,sku:'0001',barcode:'0012345678901'}])[0]).toMatchObject({sku:'0001',barcode:'0012345678901'})
  })
})
