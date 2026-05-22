-- 059_fix_customer_orders_status.sql
-- Оновити CHECK constraint для customer_orders.status
-- Додати пропущені статуси: ordered, arrived, called, no_answer

ALTER TABLE customer_orders
  DROP CONSTRAINT IF EXISTS customer_orders_status_check;

ALTER TABLE customer_orders
  ADD CONSTRAINT customer_orders_status_check
  CHECK (status IN (
    'lead','new','in_progress','ordered','arrived',
    'called','no_answer','ready','completed','canceled'
  ));
