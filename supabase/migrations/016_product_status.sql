-- Migration 016: Product Status Lifecycle (ТЗ Product Status Lifecycle)
-- Перехід від BOOLEAN is_active до status: draft → active → discontinued → archived

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'discontinued', 'archived', 'blocked'));

-- Оновлюємо існуючі записи: is_active = true → 'active', is_active = false → 'blocked'
UPDATE products SET status = 'active' WHERE is_active = true AND status = 'active';
UPDATE products SET status = 'blocked' WHERE is_active = false AND status = 'active';

COMMENT ON COLUMN products.status IS 'Статус товару: draft (чернетка), active (активний), discontinued (знято з виробництва), archived (архів), blocked (заблоковано адміном)';