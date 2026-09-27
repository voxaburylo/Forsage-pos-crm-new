import { expect, it } from 'vitest'
import { invoiceListQuery, readInvoiceListState, invoiceDraftMatchesSearch } from './invoiceListState'
it('roundtrips page, filter and literal Cyrillic search; repairs invalid page/filter', () => {
  const state = { page: 17, status: 'posted', search: 'Фільтр 100% & WIX' }
  expect(readInvoiceListState(invoiceListQuery(state))).toEqual(state)
  for (const page of ['0', '-1', '1.2', 'Infinity', 'abc']) expect(readInvoiceListState('page='+page+'&status=unknown').page).toBe(1)
  expect(readInvoiceListState('status=unknown').status).toBe('')
})
it('matches all words on one draft item without case sensitivity or wildcard expansion', () => {
  const items = [{ product_name: 'Фільтр WIX', sku: 'WA9428', barcode: '5449000351081' }, { product_name: 'Ремінь' }]
  for (const query of ['фІлЬТр WA9428', '5449000351081', '  ']) expect(invoiceDraftMatchesSearch(items, query)).toBe(true)
  for (const query of ['Фільтр ремінь', '%', 'unknown']) expect(invoiceDraftMatchesSearch(items, query)).toBe(false)
})
