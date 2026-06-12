-- 114_sale_commission_source.sql
-- Комісія за прямі продажі на касі (не лише за замовлення).
-- Джерело комісії — продаж; унікальність не дає нарахувати двічі за той самий чек.
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS commission_source_sale_id UUID;

ALTER TABLE salary_payments DROP CONSTRAINT IF EXISTS salary_payments_sale_employee_comm_key;
ALTER TABLE salary_payments ADD CONSTRAINT salary_payments_sale_employee_comm_key
  UNIQUE (commission_source_sale_id, employee_id);

NOTIFY pgrst, 'reload schema';
