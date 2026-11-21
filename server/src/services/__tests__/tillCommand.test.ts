import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { claimCommands, commandAllowedForRole, createCommand, createCommandSchema, finishCommand, readCommand } from '../tillCommandService.js'

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
    await expect(createCommand('t', 'u', command())).resolves.toEqual({ operation_id: id(1), status: 'done' })
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
})
