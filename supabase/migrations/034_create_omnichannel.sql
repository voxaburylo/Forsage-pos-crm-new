-- 034_create_omnichannel.sql
-- Повноцінна омніканальна архітектура: Channels → Chats → Messages

CREATE TABLE IF NOT EXISTS messenger_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  name        VARCHAR(200) NOT NULL,
  platform    VARCHAR(30) NOT NULL CHECK (platform IN ('telegram','viber','whatsapp')),
  credentials JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messenger_chats (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  channel_id       UUID NOT NULL REFERENCES messenger_channels(id) ON DELETE CASCADE,
  platform_chat_id VARCHAR(200) NOT NULL,
  customer_id      UUID REFERENCES customers(id),
  username         VARCHAR(200),
  first_name       VARCHAR(200),
  phone            VARCHAR(30),
  last_message_at  TIMESTAMPTZ,
  unread_count     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, platform_chat_id)
);

CREATE TABLE IF NOT EXISTS messenger_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID NOT NULL REFERENCES messenger_chats(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('customer','manager','bot')),
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Індекси
CREATE INDEX IF NOT EXISTS idx_mchannels_tenant ON messenger_channels(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_mchats_channel  ON messenger_chats(channel_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mchats_customer ON messenger_chats(customer_id);
CREATE INDEX IF NOT EXISTS idx_mmessages_chat  ON messenger_messages(chat_id, created_at ASC);

-- RLS
ALTER TABLE messenger_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messenger_channels_all" ON messenger_channels FOR ALL USING (true);
ALTER TABLE messenger_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messenger_chats_all" ON messenger_chats FOR ALL USING (true);
ALTER TABLE messenger_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messenger_messages_all" ON messenger_messages FOR ALL USING (true);

-- Seed: один Telegram канал для тесту
INSERT INTO messenger_channels (name, platform, credentials)
SELECT 'Telegram Бот', 'telegram',
  jsonb_build_object('token', COALESCE(current_setting('app.telegram_bot_token', true), ''))
WHERE NOT EXISTS (SELECT 1 FROM messenger_channels);
