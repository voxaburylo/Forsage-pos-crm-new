import { describe, expect, it } from 'vitest'
import { collectSupplyResponse } from './aiSupplyResponse'
const row = { name:'Ключ', qty:2, purchase_price_uah:141 }
const action = (products:unknown = [row], extra = {}) => ({tool:'create_products_bulk',payload:{products},...extra})
const response = (...actions:unknown[]) => ({actions})

describe('Printed total at the client response boundary', () => {
  const totalAction=(total:unknown,amount=100)=>({tool:'create_products_bulk',payload:{products:[{...row,qty:1,purchase_price_uah:amount}],invoice_total:total}})
  it('compares one invoice total with every part, without adding repeated footer totals', () => {
    expect(collectSupplyResponse([response(totalAction(250)),response(totalAction(250,150))],2).products).toHaveLength(2)
  })
  it.each([90,110])('rejects a partial/duplicated response at stated total %s', total => {
    expect(()=>collectSupplyResponse([response(totalAction(total))],1)).toThrow('підсумок')
  })
  it('does not choose between contradictory totals', () => {
    expect(()=>collectSupplyResponse([response(totalAction(250)),response(totalAction(251,150))],2)).toThrow('різні підсумки')
  })
  it.each([{},true,'100 грн/шт',1.234,-1])('rejects malformed total %j', total => {
    expect(()=>collectSupplyResponse([response(totalAction(total))],1)).toThrow()
  })
  it('keeps zero and rounds each line separately', () => {
    expect(collectSupplyResponse([response(totalAction(0,0))],1).products[0].purchase_price_uah).toBe(0)
    const products=[{...row,qty:1.5,purchase_price_uah:1.01},{...row,qty:1.5,purchase_price_uah:1.01}]
    const payload={products,invoice_total:3.04}
    expect(collectSupplyResponse([response({tool:'create_products_bulk',payload})],1).products).toHaveLength(2)
    expect(()=>collectSupplyResponse([response({tool:'create_products_bulk',payload:{...payload,invoice_total:3.03}})],1)).toThrow('підсумок')
  })
})
describe('Complete AI invoice response contract', () => {
  it('combines every valid action and keeps legitimate repeated rows', () => {
    const result = collectSupplyResponse([response(action(),action()),response(action([row,{...row,name:'Інший'}]))],2)
    expect(result.products).toHaveLength(4)
    expect(result.products.reduce((sum,p)=>sum+p.qty,0)).toBe(8)
  })
  it.each([undefined,null,{},[],{actions:null},{actions:[]}])('rejects an empty response even beside a valid part: %j', empty => {
    expect(()=>collectSupplyResponse([response(action()),empty],2)).toThrow('без таблиці')
  })
  it.each([undefined,null,{},[]])('rejects a malformed/empty action table beside valid rows: %j', rows => {
    const bad = rows === undefined ? {tool:'create_products_bulk',payload:{}} : action(rows)
    expect(()=>collectSupplyResponse([response(action(),bad)],1)).toThrow('порожня або пошкоджена')
  })
  it('rejects missing parts, unsupported actions, invalid counts and invalid rows', () => {
    expect(()=>collectSupplyResponse([response(action())],2)).toThrow('не всі')
    expect(()=>collectSupplyResponse([],0)).toThrow('не всі')
    expect(()=>collectSupplyResponse([response(action(),{tool:'create_product'})],1)).toThrow('без таблиці')
    for (const count of [0,2,'1',1.5]) expect(()=>collectSupplyResponse([response(action([row],{count}))],1)).toThrow('кількість позицій')
    expect(collectSupplyResponse([response(action([row],{count:1}))],1).products).toHaveLength(1)
    expect(()=>collectSupplyResponse([response(action([row,{name:'Поганий',qty:1}]))],1)).toThrow('закупівельну ціну')
  })
  it('preserves compatible metadata from later parts without adopting arbitrary payload fields', () => {
    const result=collectSupplyResponse([response(action()),response({tool:'create_supply_invoice_bulk',payload:{products:[row],supplier_name:' Автокомфорт ',invoice_number:'001',posted:true}})],2)
    expect(result.metadata).toEqual({supplier_name:'Автокомфорт',invoice_number:'001'})
  })
  it.each(['supplier_name','supplier_id','invoice_number'])('rejects conflicting %s instead of taking the first part', key => {
    const item=(value:unknown)=>({tool:'create_products_bulk',payload:{products:[row],[key]:value}})
    expect(()=>collectSupplyResponse([response(item('A'),item('B'))],1)).toThrow('різні постачальники')
    expect(()=>collectSupplyResponse([response(item(23))],1)).toThrow('реквізити')
  })
  it('enforces the total limit across parts, not just each individual action', () => {
    expect(()=>collectSupplyResponse([response(action(Array(1500).fill(row))),response(action(Array(501).fill(row)))],2)).toThrow('2000')
  })
})
