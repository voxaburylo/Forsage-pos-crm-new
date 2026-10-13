import { describe, expect, it } from 'vitest'
import { emptySaleHistoryView, saleHistoryLink, saleHistoryRequest, soldItemReceiptsHref } from './saleHistoryView'

describe('receipt history filters', () => {
  it('passes a report product, exact seller and Kyiv period without a name-match requirement', () => {
    const href = soldItemReceiptsHref({ productId: 'archived-id', name: 'Old name', sellerId: 'saved-seller', sellerName: 'Продавець', from: '2026-10-25', to: '2026-10-25' })
    const linked = { ...emptySaleHistoryView(), ...saleHistoryLink(new URLSearchParams(href.split('?')[1])) }
    expect(saleHistoryRequest(linked)).toEqual({ error: '', params: { page: 1, per_page: 20, search: undefined, product_id: 'archived-id', seller_id: 'saved-seller', date_from: '2026-10-24T21:00:00.000Z', date_to_exclusive: '2026-10-25T22:00:00.000Z', include_returns: '1', history_filter_version: '1' } })
  })
  it('uses historical unit price in kopecks, not receipt total or today product price', () => {
    expect(saleHistoryRequest({ ...emptySaleHistoryView(), productSearch: 'Помпа хорт', unitPrice: '625,50' }).params).toMatchObject({ product_search: 'Помпа хорт', unit_price: 62550 })
  })
  it.each(['-1', '1.001', '1e3', 'NaN', '9007199254740991'])('rejects ambiguous or unsafe price %s', unitPrice => {
    expect(saleHistoryRequest({ ...emptySaleHistoryView(), unitPrice }).error).not.toBe('')
  })
  it.each([['2026-02-30', ''], ['bad', ''], ['2026-10-15', '2026-10-01']])('rejects malformed/reversed period %s %s', (dateFrom, dateTo) => {
    expect(saleHistoryRequest({ ...emptySaleHistoryView(), dateFrom, dateTo }).error).not.toBe('')
  })
  it('keeps a plain no-filter list compatible, but generic search requires full capability', () => {
    expect(saleHistoryRequest(emptySaleHistoryView()).params.history_filter_version).toBeUndefined()
    expect(saleHistoryRequest({ ...emptySaleHistoryView(), search: 'WA9428' }).params.history_filter_version).toBe('1')
    expect(saleHistoryLink(new URLSearchParams())).toBeNull()
  })
})
