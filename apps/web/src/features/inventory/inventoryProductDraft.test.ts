import { expect, it } from 'vitest'
import { normalizeProductDrafts } from './InventoryProductInput'

it('restores exactly the typed value and the original baseline of supported fields', () => {
  const draft = { row: { name: { value: 'Новий фільтр', base: 'Старий фільтр' }, retail_price: { value: '12,50', base: 1000 } } }
  expect(normalizeProductDrafts(draft)).toEqual(draft)
})
it('keeps text without a valid baseline for explicit review, not a blind overwrite', () => {
  expect(normalizeProductDrafts({ row: { sku: { value: 'W67/1' }, retail_price: { value: '2', base: NaN } } })).toEqual({
    row: { sku: { value: 'W67/1', base: undefined }, retail_price: { value: '2', base: undefined } },
  })
})
it.each([null, undefined, 'bad', 42, []])('ignores invalid draft containers %j', input => {
  expect(normalizeProductDrafts(input)).toEqual({})
})
it('ignores unsupported, malformed and unsafe local-storage fields', () => {
  const input = JSON.parse('{"__proto__":{"name":{"value":"bad"}},"row":{"qty_on_hand":{"value":"99"},"sku":{"value":12},"name":{"value":"Товар"}},"array":[],"empty":null}')
  expect(normalizeProductDrafts(input)).toEqual({ row: { name: { value: 'Товар', base: undefined } } })
  expect(Object.prototype).not.toHaveProperty('name')
})
