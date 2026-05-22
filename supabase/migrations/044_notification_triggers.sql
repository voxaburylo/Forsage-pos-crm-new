-- 044_notification_triggers.sql
-- Автоматичні сповіщення клієнтам

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS auto_notify_order_ready BOOLEAN NOT NULL DEFAULT true;

-- Додаємо статус 'ready_for_pickup' до sales
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_status_check
  CHECK (status IN ('draft','completed','returned','suspended','ready_for_pickup'));
