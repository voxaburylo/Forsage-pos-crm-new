-- 065_wms_picking.sql
-- Додавання поля pickup_cell до таблиці customer_orders для адресного зберігання

ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS pickup_cell VARCHAR(50);
