import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('local money synchronization safety', () => {
  let root = ''
  let db: LocalDatabase
  let pos: LocalPosRepository
  let orders: LocalOrderRepository
  let sync: LocalSyncRepository
  let customerId = ''
  let cashierId = ''
  let shiftId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-money-sync-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    orders = new LocalOrderRepository(db)
    sync = new LocalSyncRepository(db)
    customerId = pos.saveCustomer({ phone: '+380501112233', full_name: 'Money sync customer' }).data.id
    cashierId = randomUUID()
    shiftId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash,
        opened_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, cashierId, timestamp, timestamp, timestamp)
    db.prepare('DELETE FROM sync_outbox').run()
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-money-sync-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses one cash-operation id locally and in the deposit outbox, then acknowledges only that row', () => {
    pos.addCustomerDeposit({
      customer_id: customerId,
      amount: 1_500,
      method: 'cash',
      shift_id: shiftId,
      user_id: cashierId,
    })

    const operation = sync.listPending(10).find((item) => item.operation_type === 'customer.deposit_changed')
    expect(operation).toBeTruthy()
    const cashOperationId = String(operation!.payload.cash_operation_id)
    expect(cashOperationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(db.prepare('SELECT id FROM cash_operations WHERE id = ?').get(cashOperationId)).toEqual({ id: cashOperationId })

    const unrelatedId = randomUUID()
    db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'cash_in', 'cashbox', 200, 'Unrelated', ?, ?, ?)
    `).run(unrelatedId, DEFAULT_TENANT_ID, shiftId, cashierId, operation!.created_at, operation!.created_at, operation!.created_at)

    sync.applyPushResults([{
      sequence: operation!.sequence,
      operation_id: operation!.operation_id,
      aggregate_id: operation!.aggregate_id,
      status: 'synced',
    }])

    expect(db.prepare('SELECT dirty_at FROM cash_operations WHERE id = ?').get(cashOperationId)).toEqual({ dirty_at: null })
    expect((db.prepare('SELECT dirty_at FROM cash_operations WHERE id = ?').get(unrelatedId) as { dirty_at: string }).dirty_at).toBe(operation!.created_at)
  })

  it('synchronizes a manual bonus edit as an idempotent delta transaction', () => {
    pos.saveCustomer({ bonus_balance: 500, user_id: cashierId }, customerId)

    const operation = sync.listPending(10).find((item) => item.operation_type === 'customer.bonus_adjusted')
    expect(operation?.payload).toMatchObject({ customer_id: customerId, amount: 500 })
    const transactionId = String(operation!.payload.transaction_id)
    expect(db.prepare('SELECT amount, transaction_type FROM bonus_transactions WHERE id = ?').get(transactionId)).toEqual({
      amount: 500,
      transaction_type: 'manual',
    })
    expect(sync.listPending(10).some((item) => item.operation_type === 'customer.updated')).toBe(false)

    sync.applyPushResults([{
      sequence: operation!.sequence,
      operation_id: operation!.operation_id,
      aggregate_id: operation!.aggregate_id,
      status: 'synced',
    }])
    expect(db.prepare('SELECT dirty_at FROM bonus_transactions WHERE id = ?').get(transactionId)).toEqual({ dirty_at: null })
  })

  it('requires an open cash shift for every order payment method', () => {
    const order = orders.saveOrder({ manager_id: cashierId, items: [] })
    expect(() => orders.addPayment(order.id, {
      user_id: cashierId,
      amount: 100,
      method: 'card',
    })).toThrow('Спочатку відкрийте касову зміну')
  })
})