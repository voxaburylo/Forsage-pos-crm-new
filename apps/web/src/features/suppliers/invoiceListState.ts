export interface InvoiceListState { page: number; status: string; search: string }
export const INVOICE_LIST_STATE_KEY = 'forsage:invoice-list:v1'
export function readInvoiceListState(query: string): InvoiceListState {
  const params = new URLSearchParams(query)
  const page = Number(params.get('page') || 1)
  const status = params.get('status') || ''
  return { page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    status: ['draft', 'posted', 'cancelled'].includes(status) ? status : '',
    search: (params.get('search') || '').slice(0, 200) }
}
export function invoiceListQuery(state: InvoiceListState): string {
  return new URLSearchParams({ page: String(state.page), status: state.status, search: state.search }).toString()
}
export function invoiceDraftMatchesSearch(items: unknown[], search = ''): boolean {
  const tokens = search.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean)
  return !tokens.length || items.some((item: any) => {
    const values = [item?.product_name, item?.name, item?.sku, item?.barcode,
      item?.product?.name, item?.product?.sku, item?.product?.barcode]
      .map(value => String(value ?? '').toLocaleLowerCase('uk-UA'))
    return tokens.every(token => values.some(value => value.includes(token)))
  })
}
