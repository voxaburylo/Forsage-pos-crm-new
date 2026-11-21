import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { isDesktopChannelAllowed, isManagerSaleChannel } from '../src/security/desktopAuthorization'

describe('core deposit refund through the local till', () => {
  let root = ''
  let db: LocalDatabase
  let pos: LocalPosRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-core-deposit-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-core-deposit-')) rmSync(root, { recursive: true, force: true })
  })

  // Товар 100 грн, застава за стару деталь 200 грн.
  function sell(options: { qty?: number; deposit?: number; method?: 'cash' | 'card'; openingCash?: number } = {}) {
    const qty = options.qty ?? 1, deposit = options.deposit ?? 20_000
    const shift = pos.openShift({ cashier_id: 'cashier', opening_cash: options.openingCash ?? 100_000 })
    const product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Стартер',
      qty_on_hand: 10, retail_price: 10_000, requires_core_return: deposit > 0, core_deposit_amount: deposit })
    const total = (10_000 + deposit) * qty
    const sale = pos.checkout({ client_operation_id: randomUUID(), cashier_id: 'cashier', shift_id: shift,
      items: [{ product_id: product.id, qty, unit_price: 10_000 }], payments: [{ method: options.method ?? 'cash', amount: total }] })
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    return { saleId: sale.sale_id, line, total }
  }
  const cash = () => pos.getExpectedCash('cashier')!.expected_amount
  const status = (id: string) => (db.prepare('SELECT core_return_status s FROM sale_items WHERE id=?').get(id) as { s: string }).s
  const dirty = (saleId: string) => (db.prepare('SELECT dirty_at d FROM sales WHERE id=?').get(saleId) as { d: string | null }).d
  const outbox = (type: string) => db.prepare("SELECT sequence, operation_id, aggregate_id, payload_json FROM sync_outbox WHERE operation_type=? AND status='pending'").all(type) as any[]
  const refund = (lineId: string, refundId = randomUUID(), user = 'cashier') =>
    pos.refundCoreDeposit({ sale_item_id: lineId, refund_id: refundId, user_id: user })

  it('shows the open deposit on the receipt and pays it out of the drawer once', () => {
    const { saleId, line } = sell()
    expect(line).toMatchObject({ core_return_status: 'pending', core_deposit_total: 20_000 })
    const before = cash()
    const id = randomUUID()
    expect(refund(line.id, id).data).toEqual({ sale_id: saleId, sale_item_id: line.id, amount: 20_000, replayed: false })
    expect(cash()).toBe(before - 20_000)
    expect(status(line.id)).toBe('refunded')
    expect(pos.getSaleForReturn(saleId).items[0].core_return_status).toBe('refunded')
    // Повтор того самого запиту (невідома відповідь) грошей вдруге не видає.
    expect(refund(line.id, id).data.replayed).toBe(true)
    expect(cash()).toBe(before - 20_000)
    // Нова спроба з іншим номером — відмова.
    expect(() => refund(line.id)).toThrow('вже повернуто')
    expect(cash()).toBe(before - 20_000)
    expect(db.prepare("SELECT type, amount, notes FROM cash_operations WHERE id=?").get(id))
      .toMatchObject({ type: 'cash_out', amount: 20_000, notes: expect.stringContaining('Стартер') })
  })

  it('refunds the deposit for every unit of the line', () => {
    const { line } = sell({ qty: 2 })
    expect(line.core_deposit_total).toBe(40_000)
    expect(refund(line.id).data.amount).toBe(40_000)
  })

  it('queues the cash movement and the status for the server', () => {
    const { saleId, line } = sell()
    const id = randomUUID()
    refund(line.id, id)
    expect(outbox('cash_operation.created').find(op => op.aggregate_id === id)).toBeTruthy()
    const op = outbox('sale.core_deposit_refunded')
    expect(op).toHaveLength(1)
    expect(op[0].aggregate_id).toBe(saleId)
    expect(JSON.parse(op[0].payload_json)).toMatchObject({ sale_id: saleId, sale_item_id: line.id, amount: 20_000, cash_operation_id: id })
  })

  it('a server pull cannot bring the deposit back until the server has confirmed the refund', () => {
    const { saleId, line } = sell()
    refund(line.id)
    expect(dirty(saleId)).not.toBeNull()
    const stale = { tenant_id: tenant, sale_items: [{ id: line.id, sale_id: saleId, product_id: line.product_id, qty: 1,
      unit_price: 10_000, discount: 0, total: 10_000, core_deposit_amount: 20_000, core_return_status: 'pending',
      created_at: '2026-11-13T10:00:00.000Z' }] } as any
    new LocalBootstrapRepository(db).applySyncChanges(tenant, stale)
    expect(status(line.id)).toBe('refunded')
    // Сервер підтвердив усі операції чека — позначку знято.
    const pending = db.prepare("SELECT sequence, operation_id FROM sync_outbox WHERE status='pending'").all() as any[]
    new LocalSyncRepository(db).applyPushResults(pending.map(row => ({ sequence: row.sequence, operation_id: row.operation_id, status: 'synced' as const })))
    expect(dirty(saleId)).toBeNull()
    expect(status(line.id)).toBe('refunded')
  })

  it('changes nothing when the drawer has no cash, the shift is not open or there is no deposit', () => {
    const { line } = sell({ method: 'card', openingCash: 0 })
    expect(() => refund(line.id)).toThrow('недостатньо готівки')
    expect(status(line.id)).toBe('pending')
    expect(outbox('sale.core_deposit_refunded')).toHaveLength(0)
    expect(() => refund(line.id, randomUUID(), 'someone-else')).toThrow('відкрийте касову зміну')
    expect(status(line.id)).toBe('pending')
    expect(() => refund(randomUUID())).toThrow('не знайдено')
  })

  it('refuses a line that never had a deposit', () => {
    const { line } = sell({ deposit: 0 })
    expect(line).toMatchObject({ core_return_status: 'none', core_deposit_total: 0 })
    expect(() => refund(line.id)).toThrow('немає застави')
  })

  it('is a cashier action, like any other money leaving the drawer', () => {
    expect(isDesktopChannelAllowed('desktop:pos:refund-core-deposit', 'cashier')).toBe(true)
    // 21.11.2026: менеджера пускає роль, а дозвіл «Може продавати» перевіряє головний ПК (managerSaleAccess).
    expect(isDesktopChannelAllowed('desktop:pos:refund-core-deposit', 'manager')).toBe(true)
    expect(isManagerSaleChannel('desktop:pos:refund-core-deposit')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:pos:refund-core-deposit', 'storekeeper')).toBe(false)
  })
})
