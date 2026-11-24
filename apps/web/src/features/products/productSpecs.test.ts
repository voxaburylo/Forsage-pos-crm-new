import { describe, expect, it } from 'vitest'
import { getSpecTemplate } from './productSpecs'

// 24.11.2026 (слово власника: «до масла — окремо допуски, до АКБ — тип Азія/Європа, полярність і що ще треба»).
describe('card characteristics for oil and batteries', () => {
  it('the «АКБ» category gets the battery fields: case type, polarity, terminals, mount', () => {
    const template = getSpecTemplate('АКБ')
    expect(template?.label).toContain('акумулятора')
    const keys = template!.fields.map(field => field.key)
    for (const key of ['capacity', 'cca', 'voltage', 'case_type', 'polarity', 'terminals', 'bottom_mount', 'length', 'width', 'height', 'technology', 'start_stop']) expect(keys, key).toContain(key)
    expect(template!.fields.find(field => field.key === 'case_type')!.options).toEqual(['Європа', 'Азія', 'Америка'])
    expect(getSpecTemplate('Акумулятори')?.label).toBe(template!.label)
  })
  it('oil gets approvals as a separate wide field', () => {
    const template = getSpecTemplate('Оливи-ATF')
    const approved = template!.fields.find(field => field.key === 'approved')!
    expect(approved).toMatchObject({ type: 'area', label: 'Допуски виробників' })
    expect(template!.fields.map(field => field.key)).toEqual(expect.arrayContaining(['viscosity', 'api', 'acea', 'ilsac', 'volume', 'synthetic', 'engine_type']))
  })
  it('other categories keep their templates; unknown ones have none', () => {
    expect(getSpecTemplate('Шини')?.label).toContain('шини')
    expect(getSpecTemplate('Батарейки')).toBeNull()
    expect(getSpecTemplate('')).toBeNull()
  })
})
