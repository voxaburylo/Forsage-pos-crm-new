-- 117_alter_cash_operations_shift_id_nullable.sql
-- Дозволити операції з касами (витрати/надходження) поза зміною (наприклад, загальні витрати).

ALTER TABLE cash_operations ALTER COLUMN shift_id DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
