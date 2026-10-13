import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'

let directory = ''
let db: LocalDatabase
const timestamp = '2026-10-01T12:00:00Z'
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'forsage-sale-people-')); db = new LocalDatabase(directory) })
afterEach(() => {
  db?.close()
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('forsage-sale-people-')) rmSync(directory, { recursive: true, force: true })
})
function person(name: string, active = true, personTenant = tenant) {
  const id = randomUUID()
  db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,is_active,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, personTenant, name, active ? 1 : 0, timestamp, timestamp, active ? null : timestamp)
  return id
}
function receipt(cashier: string, manager: string | null) {
  const id = randomUUID(), shift = randomUUID()
  db.prepare("INSERT INTO shifts(id,tenant_id,cashier_id,status,opened_at,created_at,updated_at) VALUES(?,?,?,'closed',?,?,?)").run(shift, tenant, cashier, timestamp, timestamp, timestamp)
  db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'completed',10000,'cash',?,?,?)")
    .run(id, tenant, id, cashier, manager, shift, timestamp, timestamp, timestamp)
  return new LocalPosRepository(db).getSale(id, tenant)
}
it('retains different cashier and inactive order manager names', () => {
  const cashier = person('Касир'), manager = person('Менеджер', false)
  const sale = receipt(cashier, manager)
  expect(sale.cashier).toMatchObject({ id: cashier, full_name: 'Касир', is_active: true })
  expect(sale.manager).toMatchObject({ id: manager, full_name: 'Менеджер', is_active: false, deleted_at: timestamp })
})
it('does not disclose another tenant person or invent a missing historic name', () => {
  const sale = receipt(person('Чужий касир', true, 'other-tenant'), randomUUID())
  expect(sale.cashier).toBeNull()
  expect(sale.manager).toBeNull()
})
it('ordinary receipt has no fabricated manager', () => {
  const sale = receipt(person('Продавець'), null)
  expect(sale.cashier.full_name).toBe('Продавець')
  expect(sale.manager).toBeNull()
})
it('reads the original order link and completed refund history without including other tenants or canceled refunds', () => {
  const sale = receipt(person('Касир'), person('Менеджер'))
  const order = randomUUID()
  db.prepare("INSERT INTO customer_orders(id,tenant_id,order_number,status,sale_id,created_at,updated_at) VALUES(?,?,?,'completed',?,?,?)")
    .run(order, tenant, order, sale.id, timestamp, timestamp)
  for (const [returnTenant, status, deleted] of [[tenant, 'completed', null], [tenant, 'cancelled', null], [tenant, 'completed', timestamp], ['foreign', 'completed', null]]) {
    db.prepare("INSERT INTO customer_returns(id,tenant_id,sale_id,reason,refund_method,refund_kopecks,stock_action,status,created_at,updated_at,deleted_at) VALUES(?,?,?,'Тест','cash',1200,'restock',?,?,?,?)")
      .run(randomUUID(), returnTenant, sale.id, status, timestamp, timestamp, deleted)
  }
  const detail = new LocalPosRepository(db).getSale(sale.id, tenant)
  expect(detail.is_order_sale).toBe(true)
  expect(detail.returns).toHaveLength(1)
  expect(detail.returns[0]).toMatchObject({ refund_kopecks: 1200, refund_method: 'cash', created_at: timestamp })
  db.prepare('UPDATE customer_orders SET deleted_at = ? WHERE id = ?').run(timestamp, order)
  expect(new LocalPosRepository(db).getSale(sale.id, tenant).is_order_sale).toBe(false)
})
