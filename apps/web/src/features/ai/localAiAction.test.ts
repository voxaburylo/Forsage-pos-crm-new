import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ customer: vi.fn(), order: vi.fn(), bridge: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: mocks.bridge }))
vi.mock('@/features/orders/orderApi', () => ({ orderApi: { create: mocks.order } }))
vi.mock('@/features/customers/customerApi', () => ({ customerApi: { quickCreate: mocks.customer } }))
import { aiOrderPayload, applyLocalAiAction } from './localAiAction'

describe('AI local business writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bridge.mockReturnValue({ orders: { save: vi.fn() }, pos: { saveCustomer: vi.fn() } })
    mocks.customer.mockResolvedValue({ data: { id: 'existing-customer' }, meta: { reused: true } })
    mocks.order.mockResolvedValue({ data: { id: 'local-order', status: 'lead' } })
  })
  it('converts hryvnias to kopecks and never copies AI payments or completed status', () => {
    const body = aiOrderPayload({ is_done: true, prepayment: 500, status: 'completed', items: [{ name: 'Фільтр', qty: 2, sell_price_uah: '225,50' }] })
    expect(body.items[0]).toMatchObject({ qty: 2, sell_price: 22550, buy_price: 0, item_status: 'pending' })
    expect(body).not.toHaveProperty('prepayment')
    expect(body).not.toHaveProperty('status')
  })
  it('reuses a customer by phone and saves the order through the local API', async () => {
    const result = await applyLocalAiAction('create_order', { customer_phone: '0500000011', customer_name: 'Клієнт', items: [] })
    expect(mocks.customer).toHaveBeenCalledWith('0500000011', 'Клієнт')
    expect(mocks.order).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'existing-customer' }))
    expect(result.data.result.customer_created).toBe(false)
  })
  it('validates rows before creating any customer', async () => {
    await expect(applyLocalAiAction('create_order', { customer_phone: '0500000011', items: [{ name: 'Фільтр', qty: -2 }] })).rejects.toThrow('кількість')
    expect(mocks.customer).not.toHaveBeenCalled()
    expect(mocks.order).not.toHaveBeenCalled()
  })
  it('does not route unsupported bulk actions to a remote database', async () => {
    await expect(applyLocalAiAction('merge_products_bulk', {})).rejects.toThrow('локальний запис')
    expect(mocks.order).not.toHaveBeenCalled()
  })
  it('refuses a broken local bridge instead of using a server', async () => {
    mocks.bridge.mockReturnValue(null)
    await expect(applyLocalAiAction('create_order', {})).rejects.toThrow('Локальна база')
  })
  it('preserves a VIN-only draft but rejects an invalid VIN', () => {
    expect(aiOrderPayload({ vin: 'WVWZZZ1JZXW000001' }).vehicle_info?.vin).toBe('WVWZZZ1JZXW000001')
    expect(() => aiOrderPayload({ vin: 'bad' })).toThrow('VIN')
  })
})
