-- 056_customer_groups.sql
-- Групи клієнтів (СТОшники, Опт, Vip, тощо)

-- =============================================================
-- 1. Таблиця груп
-- =============================================================
CREATE TABLE IF NOT EXISTS customer_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  name        VARCHAR(100) NOT NULL,
  color       VARCHAR(7) DEFAULT '#6366F1',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_groups_tenant ON customer_groups(tenant_id, sort_order);

ALTER TABLE customer_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_groups_all" ON customer_groups;
CREATE POLICY "customer_groups_all" ON customer_groups FOR ALL USING (true);

-- =============================================================
-- 2. Зв'язка клієнтів з групами
-- =============================================================
CREATE TABLE IF NOT EXISTS customer_group_members (
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  group_id     UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_cgm_customer ON customer_group_members(customer_id);
CREATE INDEX IF NOT EXISTS idx_cgm_group ON customer_group_members(group_id);

ALTER TABLE customer_group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_group_members_all" ON customer_group_members;
CREATE POLICY "customer_group_members_all" ON customer_group_members FOR ALL USING (true);

-- =============================================================
-- 3. Групи за замовчуванням
-- =============================================================
INSERT INTO customer_groups (name, color, sort_order) VALUES
  ('СТОшники', '#F59E0B', 1),
  ('Vip',      '#8B5CF6', 2),
  ('Опт',      '#3B82F6', 3),
  ('Проблемні','#EF4444', 4),
  ('Нові',     '#10B981', 5)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
