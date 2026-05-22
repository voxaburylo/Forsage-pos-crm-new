-- 035_add_pickup_cell_to_sales.sql
-- Додаємо pickup_cell для відкладених чеків + статус 'suspended'

ALTER TABLE sales ADD COLUMN IF NOT EXISTS pickup_cell VARCHAR(50);

-- Розширюємо CHECK для status
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_status_check
  CHECK (status IN ('draft','completed','returned','suspended'));
