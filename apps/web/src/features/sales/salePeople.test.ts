import { describe, expect, it } from 'vitest'
import { salePersonLabel } from './salePeople'

describe('historical receipt people', () => {
  it('uses the person provided, without current logged-in seller fallback', () => {
    expect(salePersonLabel({ id: 'a', full_name: ' Касир ' })).toBe('Касир')
    expect(salePersonLabel({ id: 'b', full_name: 'Менеджер', is_active: false })).toBe('Менеджер (неактивний)')
    expect(salePersonLabel({ id: 'c', full_name: 'Колишній касир', deleted_at: '2026-01-01' })).toBe('Колишній касир (неактивний)')
  })
  it.each([null, undefined, { id: 'a', full_name: '' }, { id: 'a', full_name: 'a' }, { id: 'a', full_name: '00112233-4455-6677-8899-aabbccddeeff' }])('never substitutes IDs for missing names', person => {
    expect(salePersonLabel(person)).toBe('Не вказано в історичному записі')
  })
})
