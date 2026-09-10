import type { orderApi, CreateOrderPayload, CustomerOrder } from './orderApi'

type OrderWriter = Pick<typeof orderApi, 'create' | 'update' | 'updateStatus'>

export async function saveOrderForm(writer: OrderWriter, payload: CreateOrderPayload, options: {
  id?: string; version?: string; activate: boolean; onPersisted: (order: CustomerOrder) => void
}): Promise<{ order: CustomerOrder; activationError: unknown | null }> {
  const result = options.id
    ? await writer.update(options.id, { ...payload, expected_updated_at: options.version })
    : await writer.create(payload)
  const order = result.data
  if (!order?.id) throw new Error('Не отримано ідентифікатор замовлення')
  // Once persisted, never offer to create this document again after a status failure.
  options.onPersisted(order)
  if (options.activate && ['lead', 'quoted'].includes(order.status)) {
    try { await writer.updateStatus(order.id, 'new') }
    catch (activationError) { return { order, activationError } }
  }
  return { order, activationError: null }
}
