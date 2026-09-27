import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

let root: string, db: LocalDatabase, repo: LocalStaffRepository
const time = '2026-09-22T13:40:00.000Z', day = '2026-09-22'
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-tire-detail-'))
  db = new LocalDatabase(root); repo = new LocalStaffRepository(db)
  for (const [id, name, role] of [['worker', 'Андрій', 'tire_worker'], ['cashier', 'Никита', 'cashier']]) {
    db.prepare(`INSERT INTO staff_users (id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
      VALUES (?,?,?,?,1,0,'day',?,?)`).run(id, tenant, name, role, time, time)
  }
  db.prepare(`INSERT INTO shifts(id,tenant_id,cashier_id,status,opening_cash,opened_at,created_at,updated_at)
    VALUES ('shift',?,'cashier','open',0,?,?,?)`).run(tenant,time,time,time)
  db.prepare(`INSERT INTO products(id,tenant_id,sku,name,purchase_price,retail_price,qty_on_hand,created_at,updated_at)
    VALUES ('service',?,'POS-TIRE-SERVICE','Шиномонтаж',0,36000,0,?,?)`).run(tenant,time,time)
  db.prepare(`INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,cash_amount,notes,completed_at,created_at,updated_at)
    VALUES ('sale',?,'TIRE-47','cashier','worker','shift','completed',36000,'cash',36000,'Шиномонтаж: заміна 4 коліс R16',?,?,?)`).run(tenant,time,time,time)
  for (const [id, description, amount] of [['a', 'Заміна коліс', 24000], ['b', 'Балансування', 12000]]) {
    db.prepare(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,sku,description,qty,unit_price,purchase_price,total,created_at,updated_at)
      VALUES (?,?,'sale','service','POS-TIRE-SERVICE',?,1,?,0,?,?,?)`).run(id,tenant,description,amount,amount,time,time)
  }
  db.prepare(`INSERT INTO commission_rules(id,tenant_id,user_id,pct_from_revenue,pct_from_profit,rule_type,created_at,updated_at)
    VALUES ('rule',?,'worker',35,0,'tire_service',?,?)`).run(tenant,time,time)
  repo.recordSaleCommissions('sale', tenant, 'cashier')
})
afterEach(() => {
  db.close()
  if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-tire-detail-')) rmSync(root,{recursive:true,force:true})
})
function salary(id: string, amount: number, type = 'bonus', source = 'manual') {
  db.prepare(`INSERT INTO salary_payments(id,tenant_id,employee_id,employee_name,amount,type,method,period,work_date,source,note,created_by,created_at,updated_at)
    VALUES (?,?,'worker','Андрій',?,?,'cash','2026-09',?,?,?,'cashier','2026-09-25T07:00:00Z',?)`).run(id,tenant,amount,type,day,source,'Примітка '+id,time)
}
it('explains 360 грн × 35% = 126 грн with cashier, comment and all work lines; keeps the saved commission after a rule change', () => {
  db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
  db.prepare("UPDATE products SET sku='RENAMED-SERVICE'").run()
  const report = repo.tireServiceReport(day)
  expect(report.details_version).toBe(1)
  expect(report.receipts).toHaveLength(1)
  expect(report.receipts[0]).toMatchObject({cashier_name:'Никита',notes:'Шиномонтаж: заміна 4 коліс R16',service_revenue:36000,commission_earned:12600})
  expect(report.receipts[0].services.map((item: any) => item.description).sort()).toEqual(['Балансування','Заміна коліс'])
  expect(report.salary_operations).toHaveLength(1)
  expect(report.salary_operations[0]).toMatchObject({amount:12600,sale_id:'sale',cashier_name:'Никита'})
  expect(report.data[0]).toMatchObject({commission_earned:12600,earned:12600,due:12600})
})
it('keeps late handover and payout on their work day and shows the actual operation time', () => {
  db.prepare(`INSERT INTO cash_operations(id,tenant_id,shift_id,user_id,type,source,amount,employee_id,work_date,notes,created_at,updated_at)
    VALUES ('handover',?,'shift','cashier','cash_in','cashbox',36000,'worker',?,'Каса за 22 вересня','2026-09-25T07:30:00Z',?)`).run(tenant,day,time)
  salary('payout',10000,'advance')
  const report = repo.tireServiceReport(day)
  expect(report.data[0]).toMatchObject({paid:10000,due:2600,cash_handed_over:36000,cash_pending:0})
  expect(report.cash_handovers[0]).toMatchObject({cashier_name:'Никита',work_date:day,created_at:'2026-09-25T07:30:00Z'})
  expect(report.salary_operations.find((row: any) => row.id==='payout')).toMatchObject({work_date:day,created_at:'2026-09-25T07:00:00Z'})
  expect(repo.tireServiceReport('2026-09-25').salary_operations).toEqual([])
})
it('shows reversals, bonuses and deductions without duplicating them per work line', () => {
  salary('reversal',-3600,'bonus','commission_reversal'); salary('bonus',1000); salary('penalty',500,'penalty')
  const report = repo.tireServiceReport(day)
  expect(report.data[0]).toMatchObject({commission_earned:9000,earned:10000,penalty:500,due:9500})
  expect(report.salary_operations).toHaveLength(4)
  expect(report.receipts[0].commission_earned).toBe(12600)
})
it('excludes deleted and other-tenant operations and never writes when reading the report', () => {
  salary('deleted',999999); salary('foreign',999999)
  db.prepare('UPDATE salary_payments SET deleted_at=? WHERE id=?').run(time,'deleted')
  db.prepare('UPDATE salary_payments SET tenant_id=? WHERE id=?').run('another-shop','foreign')
  const before = db.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get()
  const report = repo.tireServiceReport(day)
  expect(report.salary_operations).toHaveLength(1); expect(report.data[0].due).toBe(12600)
  expect(db.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get()).toEqual(before)
})
it('marks a projected daily rate separately and does not add it twice after posting', () => {
  db.prepare("UPDATE staff_users SET base_rate=5000 WHERE id='worker'").run()
  expect(repo.tireServiceReport(day).data[0]).toMatchObject({daily_rate:5000,daily_rate_projected:5000,earned:17600})
  salary('rate',5000,'salary','daily_rate')
  expect(repo.tireServiceReport(day).data[0]).toMatchObject({daily_rate:5000,daily_rate_projected:0,earned:17600})
})
