import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

let directory = ''
let db: LocalDatabase
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'forsage-tire-history-volume-')); db = new LocalDatabase(directory) })
afterEach(() => {
  db?.close()
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('forsage-tire-history-volume-')) rmSync(directory, { recursive: true, force: true })
})

it.each([1, 50, 100])('returns the complete isolated day of %i receipts per worker without a display-page cap', count => {
  const staff = new LocalStaffRepository(db)
  const timestamp = '2026-09-30T16:00:00.000Z'
  const cashier = randomUUID(), shift = randomUUID(), product = randomUUID()
  const workers = [randomUUID(), randomUUID()]
  db.prepare("INSERT INTO staff_users (id,tenant_id,full_name,role,is_active,created_at,updated_at) VALUES (?,?,?,'cashier',1,?,?)")
    .run(cashier, tenant, 'Касир вечірньої зміни', timestamp, timestamp)
  db.prepare("INSERT INTO shifts (id,tenant_id,cashier_id,status,opening_cash,opened_at,created_at,updated_at) VALUES (?,?,?,'open',0,?,?,?)")
    .run(shift, tenant, cashier, timestamp, timestamp, timestamp)
  db.prepare("INSERT INTO products (id,tenant_id,sku,name,purchase_price,retail_price,qty_on_hand,created_at,updated_at) VALUES (?,?,'POS-TIRE-SERVICE','Тестова послуга',0,10000,0,?,?)")
    .run(product, tenant, timestamp, timestamp)
  for (const [index, worker] of workers.entries()) {
    db.prepare("INSERT INTO staff_users (id,tenant_id,full_name,role,is_active,created_at,updated_at) VALUES (?,?,?,'tire_worker',1,?,?)")
      .run(worker, tenant, 'Майстер ' + index, timestamp, timestamp)
    db.prepare("INSERT INTO commission_rules (id,tenant_id,user_id,pct_from_revenue,pct_from_profit,rule_type,created_at,updated_at) VALUES (?,?,?,10,0,'tire_service',?,?)")
      .run(randomUUID(), tenant, worker, timestamp, timestamp)
    for (let i = 0; i < count; i++) {
      const sale = randomUUID()
      db.prepare("INSERT INTO sales (id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,completed_at,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,'completed',10000,'cash',?,?,?,?)")
        .run(sale, tenant, `VOLUME-${index}-${i}`, cashier, worker, shift, timestamp, 'Коментар ' + i, timestamp, timestamp)
      db.prepare('INSERT INTO sale_items (id,tenant_id,sale_id,product_id,sku,qty,unit_price,purchase_price,total,created_at,updated_at) VALUES (?,?,?,?,?,1,10000,0,10000,?,?)')
        .run(randomUUID(), tenant, sale, product, 'POS-TIRE-SERVICE', timestamp, timestamp)
      expect(staff.recordSaleCommissions(sale, tenant, cashier)).toHaveLength(1)
    }
  }
  const report = staff.tireServiceReport('2026-09-30', tenant)
  expect(report.receipts).toHaveLength(count * 2)
  expect(report.salary_operations).toHaveLength(count * 2)
  expect(new Set(report.receipts.map((receipt: { id: string }) => receipt.id)).size).toBe(count * 2)
  for (const worker of workers) {
    expect(report.receipts.filter((receipt: { employee_id: string }) => receipt.employee_id === worker)).toHaveLength(count)
    expect(report.salary_operations.filter((operation: { employee_id: string }) => operation.employee_id === worker)).toHaveLength(count)
  }
  expect(report.receipts.every((receipt: { cashier_name: string; notes: string }) => receipt.cashier_name === 'Касир вечірньої зміни' && receipt.notes.startsWith('Коментар '))).toBe(true)
  expect(staff.tireServiceReport('2026-10-01', tenant).receipts).toHaveLength(0)
  db.prepare("UPDATE staff_users SET is_active = 0, deleted_at = ?, rate_period = 'day', base_rate = 50000 WHERE id = ?")
    .run('2026-10-02T08:00:00Z', workers[0])
  const archived = staff.tireServiceReport('2026-09-30', tenant)
  expect(archived.receipts).toHaveLength(count * 2)
  expect(archived.data.find((row: { employee_id: string }) => row.employee_id === workers[0]))
    .toMatchObject({ employee_active: false, earned: count * 1000, daily_rate_projected: 0, salary_ready: false, payable_due: 0 })
  expect(staff.tireServiceReport('2026-10-01', tenant).data.some((row: { employee_id: string }) => row.employee_id === workers[0])).toBe(false)
})
