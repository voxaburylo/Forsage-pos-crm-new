-- 116_vin_decoder_settings.sql
-- Поля інтеграції VIN-декодера (URL зовнішнього API + ключ). За замовчуванням
-- ПОРОЖНІ — власник заповнить пізніше в Налаштуваннях. Поки порожні — декодер
-- повертає "не налаштовано".

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS vin_decoder_url     TEXT;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS vin_decoder_api_key TEXT;

NOTIFY pgrst, 'reload schema';
