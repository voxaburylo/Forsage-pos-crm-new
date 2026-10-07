import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const migration=readFileSync(new URL('../../../../supabase/migrations/20261004174013_sale_copy_payment_integrity.sql',import.meta.url),'utf8')
let db:PGlite
beforeEach(async()=>{
  db=new PGlite()
  await db.exec(`CREATE TABLE sales(id int PRIMARY KEY,status text,total int,payment_method text,is_debt boolean,
    cash_amount int,card_amount int,transfer_amount int);
    ALTER TABLE sales ADD CONSTRAINT sales_payment_amounts_match CHECK (
      payment_method='debt' OR (payment_method='cash' AND cash_amount=total)
      OR (payment_method='mixed' AND cash_amount+card_amount=total AND transfer_amount=0));
    INSERT INTO sales VALUES(1,'completed',1000,'cash',false,1000,0,0),(2,'returned',2000,'debt',true,0,0,0);
    ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_test ON sales USING(false);`)
})
afterEach(async()=>{await db.close()})
it('reproduces the old rejection, then accepts transfer/debt mixtures without changing old rows',async()=>{
  await expect(db.exec("INSERT INTO sales VALUES(3,'completed',1000,'mixed',false,400,0,600)")).rejects.toThrow()
  const before=(await db.query('SELECT * FROM sales ORDER BY id')).rows
  const policies=(await db.query("SELECT * FROM pg_policies WHERE tablename='sales'")).rows
  await db.exec(migration)
  await db.exec("INSERT INTO sales VALUES(3,'completed',1000,'mixed',false,400,0,600,0),(4,'completed',1000,'mixed',true,400,0,0,600)")
  const after=(await db.query('SELECT id,status,total,payment_method,is_debt,cash_amount,card_amount,transfer_amount FROM sales WHERE id<3 ORDER BY id')).rows
  expect(after).toEqual(before)
  expect((await db.query('SELECT debt_amount FROM sales WHERE id<3')).rows.every((row:any)=>row.debt_amount===null)).toBe(true)
  expect((await db.query("SELECT * FROM pg_policies WHERE tablename='sales'")).rows).toEqual(policies)
  expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='sales'")).rows[0].relrowsecurity).toBe(true)
})
it.each([
  "INSERT INTO sales VALUES(3,'completed',1000,'mixed',false,400,0,500,0)",
  "INSERT INTO sales VALUES(3,'completed',1000,'mixed',false,400,0,0,600)",
  "INSERT INTO sales VALUES(3,'completed',1000,'cash',true,400,0,0,600)",
  "INSERT INTO sales VALUES(3,'completed',1000,'debt',true,0,0,0,999)",
  "INSERT INTO sales VALUES(3,'completed',1000,'mixed',true,400,0,601,-1)",
])('keeps invalid money constrained: %s',async sql=>{
  await db.exec(migration);await expect(db.exec(sql)).rejects.toThrow()
  expect((await db.query('SELECT * FROM sales')).rows).toHaveLength(2)
})
it('can be safely reapplied and remains compatible with the older pure-debt writer',async()=>{
  await db.exec(migration);await db.exec(migration)
  await db.exec("INSERT INTO sales(id,status,total,payment_method,is_debt,cash_amount,card_amount,transfer_amount) VALUES(3,'completed',1000,'debt',true,0,0,0)")
  expect((await db.query('SELECT debt_amount FROM sales WHERE id=3')).rows[0].debt_amount).toBeNull()
})
it('rolls back instead of repairing an incompatible old receipt',async()=>{
  await db.exec("ALTER TABLE sales DROP CONSTRAINT sales_payment_amounts_match; UPDATE sales SET cash_amount=999 WHERE id=1")
  await expect(db.exec(migration)).rejects.toThrow()
  await db.exec('ROLLBACK')
  expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='sales' AND column_name='debt_amount'")).rows).toHaveLength(0)
  expect((await db.query('SELECT cash_amount FROM sales WHERE id=1')).rows[0].cash_amount).toBe(999)
})
