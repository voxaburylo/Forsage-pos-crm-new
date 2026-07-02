-- 051_telegram_enhance.sql
-- Phase 10: Розширення Telegram-бота з підтримкою Business + Omnichannel

-- =============================================================
-- 1. Розширення telegram_messages
-- =============================================================

ALTER TABLE telegram_messages
  ADD COLUMN IF NOT EXISTS from_id          BIGINT,
  ADD COLUMN IF NOT EXISTS message_type     VARCHAR(30) NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS metadata         JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_business      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS business_connection_id VARCHAR(255);

COMMENT ON COLUMN telegram_messages.from_id IS 'Telegram user ID відправника (для фільтрації власника)';
COMMENT ON COLUMN telegram_messages.message_type IS 'text | photo | contact | vin | command';
COMMENT ON COLUMN telegram_messages.metadata IS 'Додаткові дані: username, first_name, caption, OCR result тощо';
COMMENT ON COLUMN telegram_messages.is_business IS 'Чи це business_message (особистий чат власника)';
COMMENT ON COLUMN telegram_messages.business_connection_id IS 'ID бізнес-підключення для відповіді';

-- Індекси для швидкого пошуку
CREATE INDEX IF NOT EXISTS idx_telegram_messages_from_id
  ON telegram_messages(from_id) WHERE from_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_messages_business
  ON telegram_messages(is_business, created_at DESC) WHERE is_business = true;

-- =============================================================
-- 2. Впевнюємось що telegram_chat_id та card_barcode є в customers
--    (додано в 023 та 045 — просто перестраховка)
-- =============================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_customers_telegram
  ON customers(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS card_barcode VARCHAR(50) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_customers_card_barcode
  ON customers(card_barcode) WHERE card_barcode IS NOT NULL;

-- =============================================================
-- 3. Фінальні зміни з ТЗ
-- =============================================================

-- Переконуємось, що тип даних BIGINT (для довгих ID Телеграму)
ALTER TABLE customers ALTER COLUMN telegram_chat_id TYPE BIGINT;

-- Додаємо унікальність, щоб один чат не прилип до двох клієнтів
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_tg_chat_id ON customers(telegram_chat_id);
