import { describe, expect, it } from 'vitest'
import type { Customer } from '@/types/customer'
import { customerEditorUpdate, customerEditorValues } from './customerEditorModel'

const customer = {
  id: 'customer', phone: '00123', full_name: 'Клієнт', email: 'mail@example.test', birth_date: '1990-01-02',
  card_barcode: '000123', notes: 'Примітка', tags: ['VIP', 'Власний тег'], discount_pct: 5, bonus_balance: 1234,
  client_status: 'client', loyalty_mode: 'discount', price_tier_id: 'tier', vip_level: 'silver', risk_profile: 'medium',
  updated_at: 'version-1',
} as Customer

describe('one customer editor field contract', () => {
  it('preserves fields from both former editors, including tags and leading zeros', () => {
    const form = customerEditorValues(customer)
    expect(form).toMatchObject({ phone: '00123', card_barcode: '000123', birth_date: '1990-01-02', tags: ['VIP', 'Власний тег'], bonus_balance: '12.34', loyalty_mode: 'discount', vip_level: 'silver', risk_profile: 'medium' })
    form.tags.push('СТО')
    expect(customer.tags).toEqual(['VIP', 'Власний тег'])
  })
  it('initializes legacy optional fields without dropping ordinary editable fields', () => {
    expect(customerEditorValues({ phone: '123' })).toMatchObject({ phone: '123', birth_date: '', tags: [], bonus_balance: '0.00', loyalty_mode: 'discount' })
  })
  it.each(['owner', 'admin', 'manager'])('%s can save all supported existing fields with concurrency protection', (role) => {
    const form = customerEditorValues(customer)
    form.tags = ['СТО']; form.bonus_balance = '15,50'; form.discount_pct = '7,5'; form.loyalty_mode = 'cashback'
    expect(customerEditorUpdate(customer, form, role)).toMatchObject({ tags: ['СТО'], birth_date: '1990-01-02', card_barcode: '000123', bonus_balance: 1550, expected_bonus_balance: 1234, expected_updated_at: 'version-1', discount_pct: 7.5, loyalty_mode: 'cashback', price_tier_id: 'tier' })
  })
  it('does not write an unchanged bonus balance', () => {
    expect(customerEditorUpdate(customer, customerEditorValues(customer), 'owner')).not.toHaveProperty('bonus_balance')
  })
  it('cashier can edit card, tags, ordinary discount and status but cannot modify financial administration', () => {
    const form = customerEditorValues(customer)
    form.loyalty_mode = 'cashback'; form.bonus_balance = '900'; form.price_tier_id = 'other'; form.vip_level = 'gold'; form.risk_profile = 'high'; form.client_status = 'sto'; form.tags = ['Оптовик']
    const update = customerEditorUpdate(customer, form, 'cashier')
    expect(update).toMatchObject({ client_status: 'sto', tags: ['Оптовик'], discount_pct: 5, expected_updated_at: 'version-1' })
    for (const field of ['loyalty_mode', 'bonus_balance', 'price_tier_id', 'vip_level', 'risk_profile']) expect(update).not.toHaveProperty(field)
  })
  it('cashier cannot alter cashback percent by tampering with the draft loyalty mode', () => {
    const current = { ...customer, loyalty_mode: 'cashback' as const }
    const form = customerEditorValues(current)
    form.loyalty_mode = 'discount'; form.discount_pct = '99'
    expect(customerEditorUpdate(current, form, 'cashier')).not.toHaveProperty('discount_pct')
  })
  it.each(['tire_worker', 'storekeeper', 'viewer', '', undefined])('denies customer mutation for %s', (role) => {
    expect(() => customerEditorUpdate(customer, customerEditorValues(customer), role)).toThrow('Немає дозволу')
  })
  it.each(['NaN', 'Infinity', '-1', '101'])('rejects malformed discount %s before any mutation', (value) => {
    expect(() => customerEditorUpdate(customer, { ...customerEditorValues(customer), discount_pct: value }, 'owner')).toThrow('Знижка')
  })
  it.each(['', '-1', '1.234', 'abc'])('rejects invalid bonus %s', (value) => {
    expect(() => customerEditorUpdate(customer, { ...customerEditorValues(customer), bonus_balance: value }, 'owner')).toThrow('баланс бонусів')
  })
  it('clears optional fields intentionally, trims contacts and keeps card zeros', () => {
    const update = customerEditorUpdate(customer, { ...customerEditorValues(customer), phone: ' 00123 ', email: ' ', birth_date: '', card_barcode: ' 00 0123 ', tags: [] }, 'owner')
    expect(update).toMatchObject({ phone: '00123', email: '', birth_date: null, card_barcode: '000123', tags: [] })
  })
})
