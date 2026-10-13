import { orderApi, type OrderListFilters } from './orderApi'

/** A scoped, bounded history read; neither a malformed nor a cached page proves
 * that the customer's complete current history has been loaded. */
export async function readOrderHistoryPage(
  filters: Pick<OrderListFilters, 'customer_id' | 'chat_id'>,
  offset = 0,
  limit = 25,
) {
  if (!filters.customer_id && !filters.chat_id) throw new Error('Не вказано клієнта або чат для історії замовлень')
  const response = await orderApi.list(offset, { silent: true }, limit, filters)
  const { data, meta } = response ?? {}
  if (!Array.isArray(data) || !meta || typeof meta.has_more !== 'boolean'
    || meta.offset !== offset || meta.per_page !== limit || data.length > limit
    || (meta.has_more && data.length === 0)
    || data.some(order => !order?.id
      || (filters.customer_id && (order.customer_id ?? order.customer?.id) !== filters.customer_id)
      || (filters.chat_id && order.chat_id !== filters.chat_id))) {
    throw new Error('Не вдалося підтвердити повноту історії замовлень. Повторіть завантаження.')
  }
  return {
    data,
    hasMore: meta.has_more,
    // Advance by rows received, not deduplicated rendered rows: an updated
    // order can occur again on the next offset-based page.
    nextOffset: offset + data.length,
    incomplete: data.some(order => order.lan_sync?.state === 'cached' || order.lan_sync?.history_incomplete),
  }
}
