import { describe, expect, it } from 'vitest'
import { findExactProductForQuery } from './invoiceFormModel'

const filter = { id: 'one', name: 'Фільтр WIX WA9428', sku: 'WA9428', barcode: '2000000000001', additional_barcodes: ['2000000000099'] }
const other = { id: 'two', name: 'Фільтр інший', sku: 'OTHER', barcode: '2000000000002', additional_barcodes: null }

describe('explicit product selection in invoice and inventory', () => {
  it.each(['WA9428', ' wa9428 ', '2000000000001', '2000000000099', ' фільтр WIX   WA9428 '])('accepts a unique exact identifier or full name: %s', query => {
    expect(findExactProductForQuery(query, [other, filter])).toBe(filter)
  })
  it.each(['', 'Фільтр', 'WX WA9428', 'BO 1457434310', 'HBJ J1325037', 'невідомий'])('does not turn fuzzy text into a first match: %s', query => {
    expect(findExactProductForQuery(query, [filter, other])).toBeNull()
  })
  it('rejects duplicate identifiers even when a name happens to match', () => {
    expect(findExactProductForQuery(filter.barcode, [filter, { ...other, barcode: filter.barcode, name: filter.barcode }])).toBeNull()
    expect(findExactProductForQuery(filter.sku, [filter, { ...other, sku: filter.sku }])).toBeNull()
  })
  it('rejects duplicate names and does not strip leading zeroes', () => {
    expect(findExactProductForQuery(filter.name, [filter, { ...other, name: filter.name }])).toBeNull()
    expect(findExactProductForQuery('00012', [{ ...filter, sku: '12', barcode: null }])).toBeNull()
  })
  it('deduplicates identical result IDs without inventing ambiguity', () => {
    expect(findExactProductForQuery(filter.sku, [filter, { ...filter }])?.id).toBe(filter.id)
  })
})
