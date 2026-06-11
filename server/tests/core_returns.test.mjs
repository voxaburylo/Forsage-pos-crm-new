// Тест coreReturns на ЛОКАЛЬНІЙ тестовій базі (PGlite — вбудований Postgres).
// Жодних підключень до зовнішніх БД: база живе в пам'яті процесу.
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()

const TENANT = '11111111-1111-1111-1111-111111111111'
const CUST   = '22222222-2222-2222-2222-222222222222'
const SALE   = '33333333-3333-3333-3333-333333333333'
const SITEM  = '44444444-4444-4444-4444-444444444444'
const ORDER  = '55555555-5555-5555-5555-555555555555'
const OITEM  = '66666666-6666-6666-6666-666666666666'
const PROD   = '77777777-7777-7777-7777-777777777777'
const SUPIT  = '88888888-8888-8888-8888-888888888888'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS ${name}`)
  else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}
const q = async (sql, params) => {
  const r = await db.query(sql, params)
  return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 }
}

// === Схема тестової бази (потрібні таблиці/колонки як у прод-схемі) ===
await db.exec(`
  CREATE TABLE products (id UUID PRIMARY KEY, name TEXT);
  CREATE TABLE customers (id UUID PRIMARY KEY, tenant_id UUID, bonus_balance INTEGER DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE bonus_transactions (id SERIAL, tenant_id UUID, customer_id UUID, amount INTEGER, transaction_type TEXT, description TEXT);
  CREATE TABLE sales (id UUID PRIMARY KEY, customer_id UUID);
  CREATE TABLE sale_items (id UUID PRIMARY KEY, tenant_id UUID, sale_id UUID, product_id UUID,
    core_return_status VARCHAR(20) DEFAULT 'none' CHECK (core_return_status IN ('none','pending','returned','refunded')),
    core_deposit_amount INTEGER DEFAULT 0);
  CREATE TABLE customer_orders (id UUID PRIMARY KEY, tenant_id UUID, customer_id UUID);
  CREATE TABLE customer_order_items (id UUID PRIMARY KEY, order_id UUID, name TEXT,
    core_return_status VARCHAR(20) DEFAULT 'none' CHECK (core_return_status IN ('none','pending','returned','refunded')),
    core_deposit_amount INTEGER DEFAULT 0);
  CREATE TABLE supply_invoice_items (id UUID PRIMARY KEY, tenant_id UUID, qty NUMERIC(12,3), core_returned_qty NUMERIC(12,3) DEFAULT 0);
`)
await q(`INSERT INTO products VALUES ($1, 'Стартер Bosch')`, [PROD])
await q(`INSERT INTO customers (id, tenant_id, bonus_balance) VALUES ($1, $2, 1000)`, [CUST, TENANT])
await q(`INSERT INTO sales VALUES ($1, $2)`, [SALE, CUST])
await q(`INSERT INTO sale_items VALUES ($1, $2, $3, $4, 'pending', 50000)`, [SITEM, TENANT, SALE, PROD])
await q(`INSERT INTO customer_orders VALUES ($1, $2, $3)`, [ORDER, TENANT, CUST])
await q(`INSERT INTO customer_order_items VALUES ($1, $2, 'Генератор', 'pending', 30000)`, [OITEM, ORDER])
await q(`INSERT INTO supply_invoice_items VALUES ($1, $2, 5, 0)`, [SUPIT, TENANT])

// === Точні SQL з обробників coreReturns.ts ===
const saleSql = `
  UPDATE sale_items si SET core_return_status = $1
  FROM sales s
  WHERE si.id = $2 AND si.tenant_id = $3 AND si.sale_id = s.id
    AND si.core_return_status = $4
  RETURNING si.*, s.customer_id,
    (SELECT name FROM products WHERE id = si.product_id) AS item_name`
const orderSql = `
  UPDATE customer_order_items coi SET core_return_status = $1
  FROM customer_orders co
  WHERE coi.id = $2 AND coi.order_id = co.id AND co.tenant_id = $3
    AND coi.core_return_status = $4
  RETURNING coi.*, co.customer_id, coi.name AS item_name`
const supSql = `
  UPDATE supply_invoice_items
  SET core_returned_qty = LEAST(qty, core_returned_qty + $1)
  WHERE id = $2 AND tenant_id = $3 AND core_returned_qty < qty
  RETURNING id, qty, core_returned_qty`

console.log('--- Продаж: переходи статусів ---')
let r = await q(saleSql, ['refunded', SITEM, TENANT, 'returned'])
check('T1 pending → refunded напряму заборонено', r.rowCount === 0)

r = await q(saleSql, ['returned', SITEM, TENANT, 'pending'])
check('T2 pending → returned + назва товару', r.rowCount === 1 && r.rows[0].item_name === 'Стартер Bosch')

r = await q(saleSql, ['returned', SITEM, TENANT, 'pending'])
check('T3 повторний returned → 0 рядків', r.rowCount === 0)

await db.exec('BEGIN')
r = await q(saleSql, ['refunded', SITEM, TENANT, 'returned'])
check('T4 returned → refunded', r.rowCount === 1)
const dep = parseInt(r.rows[0].core_deposit_amount, 10)
await q(`UPDATE customers SET bonus_balance = COALESCE(bonus_balance,0) + $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`, [dep, r.rows[0].customer_id, TENANT])
await q(`INSERT INTO bonus_transactions (tenant_id, customer_id, amount, transaction_type, description) VALUES ($1,$2,$3,'manual',$4)`, [TENANT, r.rows[0].customer_id, dep, 'Повернення застави'])
await db.exec('COMMIT')

r = await q(`SELECT bonus_balance FROM customers WHERE id = $1`, [CUST])
check('T5 баланс 1000 + 50000 = 51000', r.rows[0].bonus_balance === 51000, `(=${r.rows[0].bonus_balance})`)

r = await q(saleSql, ['refunded', SITEM, TENANT, 'returned'])
check('T6 анти-double-refund: повторний refund → 0 рядків', r.rowCount === 0)

r = await q(saleSql, ['pending', SITEM, TENANT, 'returned'])
check('T7 відкат refunded → pending заборонено', r.rowCount === 0)

console.log('--- Замовлення ---')
r = await q(orderSql, ['returned', OITEM, TENANT, 'pending'])
check('T8 order: pending → returned, customer_id з join', r.rowCount === 1 && r.rows[0].item_name === 'Генератор' && r.rows[0].customer_id === CUST)

r = await q(orderSql, ['refunded', OITEM, '99999999-9999-9999-9999-999999999999', 'returned'])
check('T9 чужий tenant → 0 рядків', r.rowCount === 0)

r = await q(orderSql, ['pending', OITEM, TENANT, 'returned'])
check('T10 відкат returned → pending дозволено', r.rowCount === 1)

console.log('--- Борг постачальнику ---')
r = await q(supSql, [2, SUPIT, TENANT])
check('T11 повернуто 2 з 5 (partial)', r.rowCount === 1 && parseFloat(r.rows[0].core_returned_qty) === 2)

r = await q(supSql, [10, SUPIT, TENANT])
check('T12 повернення 10 обрізається LEAST до qty=5 (paid)', r.rowCount === 1 && parseFloat(r.rows[0].core_returned_qty) === 5)

r = await q(supSql, [1, SUPIT, TENANT])
check('T13 борг закрито → 0 рядків (409 в API)', r.rowCount === 0)

console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
