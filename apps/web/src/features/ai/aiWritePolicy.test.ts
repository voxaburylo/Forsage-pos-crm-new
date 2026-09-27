import { describe, expect, it } from 'vitest'
import { canApplyAiWrite, assertAiWriteAllowed } from './aiWritePolicy'
describe('AI write boundary', () => {
  it.each(['owner','admin','manager','cashier','storekeeper'])('preserves confirmed local documents for %s', role => {
    for (const tool of ['create_order','create_supply_invoice_bulk']) expect(canApplyAiWrite(tool,role,true)).toBe(true)
  })
  it.each(['sto_viewer','tire_worker','superadmin','',null,undefined,{}])('rejects unprivileged or unknown role %s', role => {
    expect(() => assertAiWriteAllowed('create_order',role,true)).toThrow('Дані не змінено')
  })
  it.each(['delete_products','merge_products_bulk','create_products_bulk','update_products_bulk','create_customer','run_sql','__proto__'])('does not authorize injected action %s even for owner', tool => {
    expect(canApplyAiWrite(tool,'owner',true)).toBe(false)
  })
  it('never permits cloud writes through local assistant policy', () => {
    expect(canApplyAiWrite('create_order','owner',false)).toBe(false)
    expect(canApplyAiWrite('create_supply_invoice_bulk','cashier',false)).toBe(false)
  })
})
