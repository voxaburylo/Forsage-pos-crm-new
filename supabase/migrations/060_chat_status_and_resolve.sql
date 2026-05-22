-- 060_chat_status_and_resolve.sql
-- Додати status для розділення чатів по замовленнях

ALTER TABLE messenger_chats ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'resolved'));

-- Знімаємо UNIQUE, щоб можна було створювати нові чати після закриття старих
ALTER TABLE messenger_chats DROP CONSTRAINT IF EXISTS messenger_chats_channel_id_platform_chat_id_key;

-- Індекс для пошуку відкритих чатів
CREATE INDEX IF NOT EXISTS idx_mchats_open ON messenger_chats(channel_id, platform_chat_id) WHERE status = 'open';
