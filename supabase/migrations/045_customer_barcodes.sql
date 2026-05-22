-- 045_customer_barcodes.sql
-- Картки лояльності клієнтів зі штрих-кодами

ALTER TABLE customers ADD COLUMN IF NOT EXISTS card_barcode VARCHAR(50) UNIQUE;
CREATE INDEX IF NOT EXISTS idx_customers_card_barcode ON customers(card_barcode) WHERE card_barcode IS NOT NULL;
