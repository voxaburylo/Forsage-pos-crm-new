-- 023_add_telegram_chat_id.sql
-- Додаємо telegram_chat_id для зв'язку клієнтів та замовлень з Telegram

-- Додаємо колонку до orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_orders_telegram ON orders(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- Додаємо колонку до customers (щоб знати, куди відповідати)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_customers_telegram ON customers(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- Додаємо колонку source до orders, якщо ще немає (для позначення "з Telegram")
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'manual';

-- Додаємо таблицю для вихідних повідомлень через бота
CREATE TABLE IF NOT EXISTS telegram_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  chat_id     BIGINT NOT NULL,
  direction   VARCHAR(10) NOT NULL CHECK (direction IN ('incoming','outgoing')),
  text        TEXT NOT NULL,
  order_id    UUID REFERENCES orders(id),
  sent_by     UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE telegram_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "telegram_messages_all" ON telegram_messages FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages(chat_id, created_at DESC);
