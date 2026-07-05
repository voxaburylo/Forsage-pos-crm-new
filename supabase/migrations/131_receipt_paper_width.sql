-- Persistent thermal receipt width. The browser print layout must match the
-- printer roll, otherwise Windows/Chrome scales or offsets the receipt.
ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS receipt_width_mm INTEGER NOT NULL DEFAULT 58;

ALTER TABLE shop_settings
  DROP CONSTRAINT IF EXISTS shop_settings_receipt_width_mm_check;

ALTER TABLE shop_settings
  ADD CONSTRAINT shop_settings_receipt_width_mm_check
  CHECK (receipt_width_mm IN (58, 80));
