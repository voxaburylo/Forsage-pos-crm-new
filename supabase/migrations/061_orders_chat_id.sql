-- 061_orders_chat_id.sql
-- Зв'язок між customer_orders та messenger_chats — заради об'єднання
-- модулів "Чати" і "Замовлення/Ліди" в один робочий простір.

ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS chat_id UUID
  REFERENCES messenger_chats(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_orders_chat_id
  ON customer_orders(chat_id)
  WHERE chat_id IS NOT NULL;
