import { describe, expect, it } from 'vitest'
import { canApplyAiWrite, assertAiWriteAllowed } from './aiWritePolicy'
describe('AI write boundary', () => {
  it.each(['owner','admin','manager','cashier','storekeeper'])('preserves confirmed local documents for %s', role => {
    for (const tool of ['create_order','create_supply_invoice_bulk']) expect(canApplyAiWrite(tool,role,true)).toBe(true)
  })
  it.each(['sto_viewer','tire_worker','superadmin','',null,undefined,{}])('rejects unprivileged or unknown role %s', role => {
    expect(() => assertAiWriteAllowed('create_order',role,true)).toThrow('Дані не змінено')
  })
  it.each(['delete_products','merge_products_bulk','create_products_bulk','create_customer','run_sql','__proto__'])('does not authorize injected action %s even for owner', tool => {
    expect(canApplyAiWrite(tool,'owner',true)).toBe(false)
  })
  it('lets only owner/admin write chat catalog edits, and only in the till', () => {
    for (const role of ['owner','admin']) expect(canApplyAiWrite('update_products_bulk',role,true)).toBe(true)
    expect(canApplyAiWrite('add_cross_numbers_bulk','owner',true)).toBe(true)
    expect(canApplyAiWrite('add_cross_numbers_bulk','cashier',true)).toBe(false)
    for (const role of ['manager','cashier','storekeeper',null]) expect(canApplyAiWrite('update_products_bulk',role,true)).toBe(false)
    expect(canApplyAiWrite('update_products_bulk','owner',false)).toBe(false)
  })
  it('never permits cloud writes through local assistant policy', () => {
    expect(canApplyAiWrite('create_order','owner',false)).toBe(false)
    expect(canApplyAiWrite('create_supply_invoice_bulk','cashier',false)).toBe(false)
  })
})
