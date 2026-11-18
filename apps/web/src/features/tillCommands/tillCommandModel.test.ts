import { describe, expect, it } from 'vitest'
import { buildTillUpdate, cardFields, planTillProductUpdate, type TillCardSnapshot } from './tillCommandModel'

const card = (patch: Partial<TillCardSnapshot> = {}): TillCardSnapshot => ({ name: 'Щітка 400', sku: 'WB-400', barcode: '111', retail_price: 24000,
  purchase_price: 20000, storage_bin: 'A-1', notes: null, is_active: 1, is_service: 0, ...patch })

describe('web edits executed by the till', () => {
  it('sends only changed fields together with what the employee saw', () => {
    const update = buildTillUpdate('p1', card(), { ...cardFields(card()), retail_price: 27000, storage_bin: ' ' })
    expect(update).toEqual({ product_id: 'p1', base: { retail_price: 24000, storage_bin: 'A-1' }, changes: { retail_price: 27000, storage_bin: null } })
    expect(buildTillUpdate('p1', card(), cardFields(card()))).toBeNull()
  })

  it('turns the change into a normal card save on the till', () => {
    const update = buildTillUpdate('p1', card(), { ...cardFields(card()), retail_price: 27050, name: 'Щітка 400 мм' })!
    expect(planTillProductUpdate(card(), update)).toEqual({ retail_price: '270.50', name: 'Щітка 400 мм' })
  })

  it('refuses when the till already changed the same field differently', () => {
    const update = buildTillUpdate('p1', card(), { ...cardFields(card()), retail_price: 27000 })!
    expect(() => planTillProductUpdate(card({ retail_price: 25000 }), update)).toThrow('вже змінили на касі')
    // Та сама зміна, вже внесена, — не конфлікт.
    expect(planTillProductUpdate(card({ retail_price: 27000 }), update)).toEqual({ retail_price: '270.00' })
  })

  it('never saves a price below purchase, an empty name, a service or a missing card', () => {
    const cheap = buildTillUpdate('p1', card(), { ...cardFields(card()), retail_price: 19999 })!
    expect(() => planTillProductUpdate(card(), cheap)).toThrow('нижча за закупівельну')
    const blank = buildTillUpdate('p1', card(), { ...cardFields(card()), name: '  ' })!
    expect(() => planTillProductUpdate(card(), blank)).toThrow('не може бути порожнім')
    expect(() => planTillProductUpdate(card({ is_service: 1 }), cheap)).toThrow('послуга')
    expect(() => planTillProductUpdate(null, cheap)).toThrow('не знайдено')
    expect(() => planTillProductUpdate(card(), { product_id: 'p1', base: { qty_on_hand: 1 } as any, changes: { qty_on_hand: 5 } as any })).toThrow('змінювати не можна')
  })
})
