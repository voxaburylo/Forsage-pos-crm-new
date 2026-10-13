import { describe, expect, it } from 'vitest'
import { catalogSearchScope, type CatalogSearchScope } from './catalogSearchScope'

const current: CatalogSearchScope = { category: 'oil', brand: 'elf', lowStock: true, stock: 'no_price' }
describe('catalog search scope', () => {
  it.each(['олива', 'WX WA9428', '1457434310', '', '   '])('preserves all selected filters for typed search %j', text => {
    expect(catalogSearchScope(current, 'text', text)).toEqual(current)
  })
  it('searches globally for an existing hardware barcode scan without changing the previous scope object', () => {
    const snapshot = { ...current }
    expect(catalogSearchScope(current, 'scan', '2000177521924')).toEqual({ category: '', brand: '', lowStock: false, stock: '' })
    expect(current).toEqual(snapshot)
  })
})
