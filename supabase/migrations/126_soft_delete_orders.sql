-- Безпечне видалення замовлень: приховуємо з робочих списків,
-- але зберігаємо фінансові зв'язки та історію для аудиту.

ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

CREATE INDEX IF NOT EXISTS customer_orders_active_idx
  ON customer_orders(tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';
