import { describe, expect, it, vi } from 'vitest'
import { saveOrderForm } from './orderFormSave'
import type { CustomerOrder } from './orderApi'

function setup(status: CustomerOrder['status'] = 'lead') {
  const order = { id: 'order-1', status } as CustomerOrder
  const writer = { create: vi.fn().mockResolvedValue({ data: order }), update: vi.fn().mockResolvedValue({ data: order }), updateStatus: vi.fn().mockResolvedValue({ data: order }) }
  return { writer, order, persisted: vi.fn() }
}
describe('saving and registering an order', () => {
  it('saves drafts without marking them ordered at a supplier', async () => {
    const { writer, persisted } = setup()
    const result = await saveOrderForm(writer, { items: [] }, { activate: false, onPersisted: persisted })
    expect(result.activationError).toBeNull()
    expect(writer.updateStatus).not.toHaveBeenCalled()
    expect(persisted).toHaveBeenCalledOnce()
  })
  it('registers a new customer order, not a supplier purchase', async () => {
    const { writer, persisted } = setup()
    await saveOrderForm(writer, { items: [] }, { activate: true, onPersisted: persisted })
    expect(writer.updateStatus).toHaveBeenCalledWith('order-1', 'new')
  })
  it('returns the saved order plus activation error, never retries CREATE', async () => {
    const { writer, order, persisted } = setup()
    const error = new Error('reserve conflict')
    writer.updateStatus.mockRejectedValue(error)
    const result = await saveOrderForm(writer, { items: [] }, { activate: true, onPersisted: persisted })
    expect(result).toEqual({ order, activationError: error })
    expect(writer.create).toHaveBeenCalledOnce()
    expect(persisted).toHaveBeenCalledWith(order)
    expect(persisted.mock.invocationCallOrder[0]).toBeLessThan(writer.updateStatus.mock.invocationCallOrder[0])
  })
  it('preserves backup on failed persistence', async () => {
    const { writer, persisted } = setup()
    writer.create.mockRejectedValue(new Error('write failed'))
    await expect(saveOrderForm(writer, { items: [] }, { activate: true, onPersisted: persisted })).rejects.toThrow('write failed')
    expect(persisted).not.toHaveBeenCalled()
    expect(writer.updateStatus).not.toHaveBeenCalled()
  })
  it('passes the original version on edit and does not downgrade a ready order', async () => {
    const { writer, persisted } = setup('ready')
    await saveOrderForm(writer, { items: [] }, { id: 'order-1', version: 'original', activate: true, onPersisted: persisted })
    expect(writer.update).toHaveBeenCalledWith('order-1', { items: [], expected_updated_at: 'original' })
    expect(writer.create).not.toHaveBeenCalled()
    expect(writer.updateStatus).not.toHaveBeenCalled()
  })
})
