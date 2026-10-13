import { businessDateRangeUtc } from '@/lib/businessDate'

export interface SaleHistoryView {
  search: string
  productSearch: string
  productId: string
  sellerId: string
  sellerLabel: string
  dateFrom: string
  dateTo: string
  unitPrice: string
  includeReturns: boolean
  page: number
  sourceLink: string
}

export const emptySaleHistoryView = (): SaleHistoryView => ({
  search: '', productSearch: '', productId: '', sellerId: '', sellerLabel: '',
  dateFrom: '', dateTo: '', unitPrice: '', includeReturns: false, page: 1, sourceLink: '',
})

export function saleHistoryLink(params: URLSearchParams): Partial<SaleHistoryView> | null {
  if (!['search', 'product_id', 'from', 'to'].some(key => params.has(key))) return null
  return {
    ...emptySaleHistoryView(), search: params.get('search') ?? '',
    productId: params.get('product_id') ?? '', productSearch: params.get('product_name') ?? '',
    sellerId: params.get('seller_id') ?? '', sellerLabel: params.get('seller_name') ?? '',
    dateFrom: params.get('from') ?? '', dateTo: params.get('to') ?? '',
    includeReturns: params.get('include_returns') === '1', sourceLink: params.toString(),
  }
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

export function saleHistoryRequest(view: SaleHistoryView): { params: Record<string, string | number | undefined>; error: string } {
  const params: Record<string, string | number | undefined> = { page: view.page, per_page: 20, search: view.search.trim() || undefined }
  if ((view.dateFrom && !validDate(view.dateFrom)) || (view.dateTo && !validDate(view.dateTo))) return { params, error: 'Вкажіть коректні дати.' }
  if (view.dateFrom && view.dateTo && view.dateFrom > view.dateTo) return { params, error: 'Початок періоду не може бути пізніше кінця.' }
  const rawPrice = view.unitPrice.trim().replace(',', '.')
  if (rawPrice && (!/^\d+(?:\.\d{1,2})?$/.test(rawPrice) || !Number.isSafeInteger(Math.round(Number(rawPrice) * 100)))) return { params, error: 'Ціна має бути невід’ємною сумою з точністю до копійок.' }
  if (view.productId) params.product_id = view.productId
  else if (view.productSearch.trim()) params.product_search = view.productSearch.trim()
  if (view.sellerId) params.seller_id = view.sellerId
  if (rawPrice) params.unit_price = Math.round(Number(rawPrice) * 100)
  if (view.dateFrom) params.date_from = businessDateRangeUtc(view.dateFrom, view.dateFrom).from
  // PostgreSQL keeps microseconds: <= 23:59:59.999 would omit the final 999µs.
  // Add 1ms to the existing Kyiv end-of-day calculation, preserving DST days.
  if (view.dateTo) params.date_to_exclusive = new Date(Date.parse(businessDateRangeUtc(view.dateTo, view.dateTo).to) + 1).toISOString()
  if (view.includeReturns) params.include_returns = '1'
  if (params.search || Object.keys(params).some(key => !['page', 'per_page', 'search'].includes(key))) params.history_filter_version = '1'
  return { params, error: '' }
}

export function soldItemReceiptsHref(input: { productId: string; name: string; from: string; to: string; sellerId?: string; sellerName?: string }) {
  const params = new URLSearchParams({ product_id: input.productId, product_name: input.name, from: input.from, to: input.to, include_returns: '1' })
  if (input.sellerId) { params.set('seller_id', input.sellerId); params.set('seller_name', input.sellerName ?? '') }
  return '/sales?' + params.toString()
}
