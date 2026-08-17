import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('local customer account payout', () => {
  let root = ''
  let db: LocalDatabase
  let pos: LocalPosRepository
  let sync: LocalSyncRepository
  let customerId = ''
  let cashierId = ''
  let shiftId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-payout-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    sync = new LocalSyncRepository(db)
    customerId = pos.saveCustomer({ phone: '+380501234567', full_name: 'Payout customer' }).data.id
    cashierId = randomUUID()
    shiftId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open', 10000, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, cashierId, timestamp, timestamp, timestamp)
    pos.addCustomerDeposit({
      customer_id: customerId, amount: 1_000, method: 'card', user_id: cashierId,
    })
    db.prepare('DELETE FROM sync_outbox').run()
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-payout-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pays out part of the balance once and publishes the same ids to sync', () => {
    const payoutId = randomUUID()
    const first = pos.payOutCustomerDeposit({
      customer_id: customerId, payout_id: payoutId, amount: 400, method: 'cash',
      shift_id: shiftId, user_id: cashierId,
    })
    const replay = pos.payOutCustomerDeposit({
      customer_id: customerId, payout_id: payoutId, amount: 400, method: 'cash',
      shift_id: shiftId, user_id: cashierId,
    })

    expect(first.data).toEqual({ balance: 600, replayed: false })
    expect(replay.data).toEqual({ balance: 600, replayed: true })
    expect(pos.getCustomerDeposit(customerId).balance).toBe(600)
    expect(db.prepare('SELECT amount, balance_after FROM customer_deposit_transactions WHERE id = ?').get(payoutId)).toEqual({
      amount: -400, balance_after: 600,
    })
    expect(db.prepare('SELECT type, amount FROM cash_operations WHERE id = ?').get(payoutId)).toEqual({
      type: 'cash_out', amount: 400,
    })
    const operation = sync.listPending(10).find((item) => item.operation_type === 'customer.deposit_changed')
    expect(operation?.payload).toMatchObject({
      transaction_id: payoutId, cash_operation_id: payoutId, amount: -400, method: 'cash',
    })
  })

  it('does not allow the balance to go below zero', () => {
    expect(() => pos.payOutCustomerDeposit({
      customer_id: customerId, amount: 1_001, method: 'cash', shift_id: shiftId, user_id: cashierId,
    })).toThrow('Сума видачі перевищує кошти')
    expect(pos.getCustomerDeposit(customerId).balance).toBe(1_000)
  })
})
