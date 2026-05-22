-- Migration 013: Цінові поля wholesale_price та min_price (ТЗ Pricing Logic — Price Hierarchy)
-- Всі ціни в копійках INTEGER, DEFAULT 0 для зворотної сумісності

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS wholesale_price INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_price INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN products.wholesale_price IS 'Оптова ціна в копійках (0 = не встановлено)';
COMMENT ON COLUMN products.min_price IS 'Мінімальна ціна (floor) в копійках (0 = не встановлено)';