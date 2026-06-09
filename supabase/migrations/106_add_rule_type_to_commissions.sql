-- 106_add_rule_type_to_commissions.sql
-- Додає колонку rule_type до таблиці commission_rules та змінює унікальний індекс у salary_payments

ALTER TABLE commission_rules 
  ADD COLUMN IF NOT EXISTS rule_type VARCHAR(50) NOT NULL DEFAULT 'personal_sales';

ALTER TABLE salary_payments 
  DROP CONSTRAINT IF EXISTS salary_payments_commission_source_order_id_key;

ALTER TABLE salary_payments 
  ADD CONSTRAINT salary_payments_order_employee_comm_key UNIQUE (commission_source_order_id, employee_id);

NOTIFY pgrst, 'reload schema';
