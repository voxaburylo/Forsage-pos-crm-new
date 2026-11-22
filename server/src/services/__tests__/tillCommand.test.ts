import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { claimCommands, commandAllowedForRole, createCommand, createCommandSchema, finishCommand, listWaitingOrders, readCommand } from '../tillCommandService.js'

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const command = (changes: Record<string, unknown> = { retail_price: 27000 }, base: Record<string, unknown> = { retail_price: 24000 }) =>
  ({ operation_id: id(1), command: 'product.update' as const, payload: { product_id: id(2), base, changes } })

describe('web write through the till', () => {
  beforeEach(() => query.mockReset())

  it('allows only whitelisted card fields with a known previous value', () => {
    expect(createCommandSchema.safeParse(command()).success).toBe(true)
    expect(createCommandSchema.safeParse(command({ qty_on_hand: 5 }, { qty_on_hand: 1 })).success).toBe(false)
    expect(createCommandSchema.safeParse(command({ purchase_price: 100 }, { purchase_price: 90 })).success).toBe(false)
    expect(createCommandSchema.safeParse(command({ retail_price: 100 }, {})).success).toBe(false)
    expect(createCommandSchema.safeParse(command({}, {})).success).toBe(false)
    expect(createCommandSchema.safeParse({ ...command(), command: 'sale.create' }).success).toBe(false)
    expect(createCommandSchema.safeParse({ ...command(), tenant_id: id(3) }).success).toBe(false)
  })

  it('refuses when the till is not online and writes nothing', async () => {
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-18T10:00:00Z', online: false }] })
    await expect(createCommand('t', 'u', command())).rejects.toMatchObject({ status: 409, code: 'TILL_OFFLINE' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('is idempotent by operation id and refuses a different change under the same id', async () => {
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-18T10:00:00Z', online: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ command: 'product.update', payload: { changes: { retail_price: 27000 }, base: { retail_price: 24000 }, product_id: id(2) }, status: 'done' }] })
    await expect(createCommand('t', 'u', command())).resolves.toEqual({ operation_id: id(1), status: 'done', till_online: true })
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-18T10:00:00Z', online: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ command: 'product.update', payload: { product_id: id(2), base: { retail_price: 24000 }, changes: { retail_price: 1 } }, status: 'done' }] })
    await expect(createCommand('t', 'u', command())).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
  })

  it('expires an unclaimed command before reporting it', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [{ operation_id: id(1), command: 'product.update', status: 'expired', created_at: '2026-11-18T10:00:00Z', finished_at: '2026-11-18T10:00:31Z' }] })
    await expect(readCommand('t', id(1))).resolves.toMatchObject({ status: 'expired' })
    expect(query.mock.calls[0][0]).toMatch(/status = 'pending' AND created_at <= now\(\) - make_interval/)
    await expect(readCommand('t', 'nope')).rejects.toMatchObject({ status: 404 })
  })

  it('claims only fresh pending commands, once, and records presence', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] })
    await expect(claimCommands('t', id(4))).resolves.toEqual([])
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO till_presence/)
    expect(query.mock.calls[1][0]).toMatch(/status = 'pending'[\s\S]*created_at > now\(\)[\s\S]*FOR UPDATE SKIP LOCKED/)
    await expect(claimCommands('t', 'not-a-device')).rejects.toMatchObject({ status: 422 })
  })

  it('queues an order while the till is offline, but never a card edit or a shift close', async () => {
    const order = { operation_id: id(7), command: 'order.save' as const, payload: { customer_name: 'Іван', items: [{ name: 'Фільтр', qty: 1, sell_price: 10000 }] } }
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-18T10:00:00Z', online: false }] })
      .mockResolvedValueOnce({ rows: [{ operation_id: id(7), status: 'pending' }] })
    await expect(createCommand('t', 'u', order)).resolves.toEqual({ operation_id: id(7), status: 'pending', till_online: false })
    query.mockReset()
    query.mockResolvedValueOnce({ rows: [] })
    await expect(createCommand('t', 'u', { operation_id: id(8), command: 'shift.list', payload: {} })).rejects.toMatchObject({ code: 'TILL_OFFLINE' })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('takes an invoice photographed by phone as rows for the till inbox, never as a posting', async () => {
    const draft = (payload: Record<string, unknown>) => ({ operation_id: id(7), command: 'invoice.draft' as const, payload })
    const rows = [{ name: 'Фільтр масляний', sku: 'W712/75', qty: 2, purchase_price_uah: 120.5, brand_name: 'MANN', secret: 'x' }]
    const parsed = createCommandSchema.safeParse(draft({ supplier_name: 'Vitol', invoice_number: '36214', rows }))
    expect(parsed.success).toBe(true)
    // Зайві поля рядка відкидаються; нечитана кількість чи ціна може бути відсутня — каса підсвітить рядок.
    expect((parsed as any).data.payload.rows[0]).toEqual({ name: 'Фільтр масляний', sku: 'W712/75', qty: 2, purchase_price_uah: 120.5, brand_name: 'MANN' })
    expect(createCommandSchema.safeParse(draft({ rows: [{ name: 'Без ціни' }] })).success).toBe(true)
    expect(createCommandSchema.safeParse(draft({ rows: [] })).success).toBe(false)
    expect(createCommandSchema.safeParse(draft({ rows: [{ name: '', qty: 1 }] })).success).toBe(false)
    expect(createCommandSchema.safeParse(draft({ rows: [{ name: 'Товар', qty: -1 }] })).success).toBe(false)
    expect(createCommandSchema.safeParse(draft({ rows: Array.from({ length: 301 }, () => ({ name: 'Товар' })) })).success).toBe(false)
    // Грошей і проведення в команді немає.
    expect(createCommandSchema.safeParse(draft({ rows, paid_amount: 100 })).success).toBe(false)
    expect(createCommandSchema.safeParse(draft({ rows, post: true })).success).toBe(false)
    // Каса не в мережі — накладна чекає в черзі, як і замовлення.
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-18T10:00:00Z', online: false }] })
      .mockResolvedValueOnce({ rows: [{ operation_id: id(7), status: 'pending' }] })
    await expect(createCommand('t', 'u', (parsed as any).data)).resolves.toEqual({ operation_id: id(7), status: 'pending', till_online: false })
    query.mockReset()
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [
      { operation_id: id(7), created_at: '2026-11-22T05:00:00Z', payload: { supplier_name: 'Vitol', invoice_number: '36214', rows: [{}, {}, {}] } },
    ] })
    await expect(listWaitingOrders('t', 'invoice.draft')).resolves.toEqual([
      { operation_id: id(7), created_at: '2026-11-22T05:00:00.000Z', customer: 'Vitol № 36214', items: 3, state: 'waiting', error: null },
    ])
    expect(query.mock.calls[1][1]).toEqual(['t', 'invoice.draft', 'Скасовано у вебі'])
  })
  it('lets the web add items to an existing order, but only while the till is online and with nothing but new rows', async () => {
    const add = (payload: Record<string, unknown>) => ({ operation_id: id(7), command: 'order.append' as const, payload })
    const items = [{ name: 'Фільтр', qty: 2, sell_price: 30000, buy_price: 20000 }]
    expect(createCommandSchema.safeParse(add({ order_id: id(2), author: 'Олена', comment: 'дозамовив', items })).success).toBe(true)
    expect(createCommandSchema.safeParse(add({ order_id: id(2), items: [] })).success).toBe(false)
    expect(createCommandSchema.safeParse(add({ items })).success).toBe(false)
    expect(createCommandSchema.safeParse(add({ order_id: id(2), items: [{ name: 'x', qty: 1, sell_price: 100, buy_price: 200 }] })).success).toBe(false)
    // Гроші, стан і правка наявних рядків у команді неможливі.
    for (const extra of [{ prepayment: 100 }, { status: 'completed' }, { customer_id: id(3) }, { remove: ['x'] }])
      expect(createCommandSchema.safeParse(add({ order_id: id(2), items, ...extra })).success).toBe(false)
    expect(createCommandSchema.safeParse(add({ order_id: id(2), items: [{ ...items[0], item_status: 'handed' }] })).success).toBe(false)
    // У черзі не чекає: стан замовлення на касі за 12 годин зміниться.
    query.mockResolvedValueOnce({ rows: [{ seen_at: '2026-11-18T10:00:00Z', online: false }] })
    await expect(createCommand('t', 'u', add({ order_id: id(2), items }) as any)).rejects.toMatchObject({ status: 409, code: 'TILL_OFFLINE' })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('keeps a queued order for 12 hours and everything else for 30 seconds', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] })
    await claimCommands('t', id(4))
    expect(query.mock.calls[1][0]).toContain("CASE WHEN command = 'staff.secret' THEN 604800 WHEN command IN ('order.save', 'invoice.draft') THEN 43200 ELSE 30 END")
    query.mockReset()
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [
      { operation_id: id(7), created_at: '2026-11-22T05:00:00Z', payload: { customer_name: 'Іван', customer_phone: '0671234567', items: [{}, {}] } },
      { operation_id: id(8), created_at: '2026-11-22T05:01:00Z', status: 'failed', error: 'Позиція 1: ціна нижча за закупівельну', payload: { customer_phone: '0671234567', items: [{}] } },
    ] })
    await expect(listWaitingOrders('t')).resolves.toEqual([
      { operation_id: id(7), created_at: '2026-11-22T05:00:00.000Z', customer: 'Іван', items: 2, state: 'waiting', error: null },
      // Відмова каси не зникає мовчки: її видно добу разом із причиною.
      { operation_id: id(8), created_at: '2026-11-22T05:01:00.000Z', customer: '0671234567', items: 1, state: 'failed', error: 'Позиція 1: ціна нижча за закупівельну' },
    ])
    expect(query.mock.calls[0][0]).toContain("WHEN command IN ('order.save', 'invoice.draft')")
    expect(query.mock.calls[1][1]).toEqual(['t', 'order.save', 'Скасовано у вебі'])
  })
  it('cancels a queued order only while the till has not taken it, and inserts no command for that', async () => {
    const cancel = { operation_id: id(1), command: 'order.cancel' as const, payload: { operation_id: id(7) } }
    expect(createCommandSchema.safeParse(cancel).success).toBe(true)
    expect(createCommandSchema.safeParse({ ...cancel, payload: { operation_id: id(7), force: true } }).success).toBe(false)
    query.mockResolvedValueOnce({ rowCount: 1 })
    await expect(createCommand('t', 'u', cancel)).resolves.toEqual({ operation_id: id(7), status: 'canceled' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain("UPDATE till_commands SET status = 'failed'")
    expect(query.mock.calls[0][0]).toContain("command = ANY($3::text[]) AND status = 'pending'")
    // Скасувати можна лише те, що чекає в черзі: замовлення або накладну з телефона.
    expect(query.mock.calls[0][1]).toEqual(['t', id(7), ['order.save', 'invoice.draft'], 'Скасовано у вебі'])
    // Каса вже забрала бланк: скасувати з вебу не можна, і про це сказано прямо.
    query.mockReset()
    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(createCommand('t', 'u', cancel)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
    for (const role of ['owner', 'admin', 'manager']) expect(commandAllowedForRole('order.cancel', role)).toBe(true)
  })
  it('accepts a result only from the device that claimed the command', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(finishCommand('t', id(4), id(5), { status: 'done', result: {} })).rejects.toMatchObject({ status: 404 })
    expect(query.mock.calls[0][0]).toMatch(/device_id = \$3 AND status = 'claimed'/)
  })
  it('closes a till shift from the web only for owner/admin with an explicit amount and reason', () => {
    const close = (payload: Record<string, unknown>) => ({ operation_id: id(7), command: 'shift.close', payload })
    const valid = { shift_id: id(8), cashier_id: id(9), actual_amount: 125050, comment: 'Закрито власником з вебу' }
    expect(createCommandSchema.safeParse(close(valid)).success).toBe(true)
    expect(createCommandSchema.safeParse({ operation_id: id(7), command: 'shift.list', payload: {} }).success).toBe(true)
    expect(createCommandSchema.safeParse(close({ ...valid, actual_amount: -1 })).success).toBe(false)
    expect(createCommandSchema.safeParse(close({ ...valid, actual_amount: 12.5 })).success).toBe(false)
    expect(createCommandSchema.safeParse(close({ ...valid, comment: ' ' })).success).toBe(false)
    expect(createCommandSchema.safeParse(close({ ...valid, tenant_id: id(3) })).success).toBe(false)
    expect(createCommandSchema.safeParse({ operation_id: id(7), command: 'shift.list', payload: { all: true } }).success).toBe(false)
    for (const role of ['owner', 'admin']) expect(commandAllowedForRole('shift.close', role)).toBe(true)
    for (const role of ['manager', 'cashier', undefined]) expect(commandAllowedForRole('shift.close', role)).toBe(false)
    expect(commandAllowedForRole('shift.list', 'manager')).toBe(false)
    expect(commandAllowedForRole('product.update', 'manager')).toBe(true)
  })
  it('accepts an order from the web without money and never below the purchase price', () => {
    const order = (payload: Record<string, unknown>) => ({ operation_id: id(7), command: 'order.save', payload })
    const item = { name: 'Колодки передні', sku: 'GDB1330', qty: 1, sell_price: 125000, buy_price: 90000 }
    const valid = { customer_phone: '0671234567', customer_name: 'Іван', car_make: 'Skoda', car_year: 2015, items: [item] }
    expect(createCommandSchema.safeParse(order(valid)).success).toBe(true)
    expect(createCommandSchema.safeParse(order({ customer_name: 'Без телефону', items: [{ name: 'Фільтр', qty: 2, sell_price: 0 }] })).success).toBe(true)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [] })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [{ ...item, sell_price: 80000 }] })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [{ ...item, qty: 0 }] })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [{ ...item, qty: 1.2345 }] })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ items: [item] })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ ...valid, customer_phone: '067-123' })).success).toBe(false)
    // Гроші, стан і чужий магазин з вебу не приймаються взагалі.
    for (const extra of [{ prepayment: 1000 }, { status: 'completed' }, { tenant_id: id(3) }, { initial_status: 'archived' }])
      expect(createCommandSchema.safeParse(order({ ...valid, ...extra })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [{ ...item, product_id: id(4) }] })).success).toBe(true)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [{ ...item, product_id: 'not-a-card' }] })).success).toBe(false)
    expect(createCommandSchema.safeParse(order({ ...valid, items: [{ ...item, item_status: 'handed' }] })).success).toBe(false)
    for (const role of ['owner', 'admin', 'manager']) expect(commandAllowedForRole('order.save', role)).toBe(true)
  })
})
