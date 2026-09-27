import { expect, it } from 'vitest'
import { serialProductWrite } from './serialProductWrite'
import { updateCatalogPages } from './catalogPageUpdate'
import { hryvniaToKopecks, type Product } from '@/types/product'
it('orders read-merge-save patches and recovers the queue after a rejected edit', async () => {
  let stored = { price: 100, bin: 'A1' }
  const patch = (changes: Partial<typeof stored>) => serialProductWrite('same-product', async () => {
    const snapshot = { ...stored }
    await new Promise(resolve => setTimeout(resolve, 1))
    stored = { ...snapshot, ...changes }
  })
  await Promise.all([patch({ price: 200 }), patch({ bin: 'B2' })])
  expect(stored).toEqual({ price: 200, bin: 'B2' })
  await expect(serialProductWrite('same-product', async () => { throw Error('failed') })).rejects.toThrow('failed')
  await patch({ price: 300 })
  expect(stored.price).toBe(300)
})
it('refreshes a edited product in any loaded page without reordering the list', () => {
  const pages = { 1: [{ id: 'a', retail_price: 50 } as Product], 2: [{ id: 'b', retail_price: 90 } as Product] }
  const updated = updateCatalogPages(pages, 'a', { retail_price: 100, storage_bin: 'A3' })
  expect(updated[1][0]).toMatchObject({ retail_price: 100, storage_bin: 'A3' })
  expect(updated[2][0]).toBe(pages[2][0])
  expect(pages[1][0].retail_price).toBe(50)
})
it.each(['1 250,50', '1\u00a0250.50', '1250.5', '1,250.50', '1.250,50'])('converts complete price %s without truncating at separators', value => {
  expect(hryvniaToKopecks(value)).toBe(125050)
})
it.each(['120грн9', '1.234', '12..5', 'Infinity', '-0,10', NaN, Infinity])('rejects ambiguous or invalid price %s instead of silently saving a different price', value => {
  expect(() => hryvniaToKopecks(value)).toThrow('ціна')
})
