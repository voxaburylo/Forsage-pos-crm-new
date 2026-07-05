-- 130_owner_daily_digest.sql
-- Вечірній звіт власнику в Telegram: chat_id власника + позначка «за сьогодні
-- вже надіслано» (щоб планувальник не дублював при рестартах сервера).

ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS owner_telegram_chat_id BIGINT,
  ADD COLUMN IF NOT EXISTS last_digest_date DATE;

NOTIFY pgrst, 'reload schema';
