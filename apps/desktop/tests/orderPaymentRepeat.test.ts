import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

// Етап 6 (22.11.2026): задаток за те саме замовлення прийняли на касі й на ПК менеджера майже одночасно.
let root: string, db: LocalDatabase, orders: LocalOrderRepository, shiftId: string
const cashier = '00000000-0000-4000-8000-0000000000c1'
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-pay-repeat-'))
  db = new LocalDatabase(root)
  orders = new LocalOrderRepository(db)
  db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(cashier, DEFAULT_TENANT_ID, 'Касир', 'cashier', '2026-11-22T08:00:00.000Z', '2026-11-22T08:00:00.000Z')
  const opened = new LocalPosRepository(db).openShift({ cashier_id: cashier, opening_cash: 0 }) as unknown
  shiftId = typeof opened === 'string' ? opened : (opened as { id: string }).id
})
afterEach(() => {
  db.close()
  if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-pay-repeat-')) rmSync(root, { recursive: true, force: true })
})
const pay = (orderId: string, extra: Record<string, unknown> = {}) =>
  orders.addPayment(orderId, { amount: 50000, method: 'cash', shift_id: shiftId, user_id: cashier, ...extra })

it('asks before recording the same deposit twice within two minutes', () => {
  const order = orders.saveOrder({ status: 'new', items: [{ name: 'Колодки', source_type: 'supplier', qty: 1, sell_price: 200000 }] })
  pay(order.id)
  expect(() => pay(order.id)).toThrow('Такий самий платіж за це замовлення вже внесено щойно')
  expect(orders.listPayments(order.id)).toHaveLength(1)
  expect(pay(order.id, { confirm_repeat: true }).order.total_paid).toBe(100000)
  // Інша сума чи спосіб — не повтор.
  expect(pay(order.id, { amount: 30000 }).order.total_paid).toBe(130000)
})

it('a retry with the same payment id is not a repeat — it returns the same payment', () => {
  const order = orders.saveOrder({ status: 'new', items: [{ name: 'Колодки', source_type: 'supplier', qty: 1, sell_price: 200000 }] })
  const first = pay(order.id, { payment_id: '00000000-0000-4000-8000-000000000001' })
  expect(pay(order.id, { payment_id: '00000000-0000-4000-8000-000000000001' }).data.id).toBe(first.data.id)
  expect(orders.listPayments(order.id)).toHaveLength(1)
})
