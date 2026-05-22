-- 066_manager_commissions.sql
-- Створення таблиці для правил комісійних менеджерів та розширення таблиці виплат

CREATE TABLE IF NOT EXISTS commission_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  user_id        UUID, -- NULL означає будь-якого менеджера
  brand_id       UUID, -- NULL означає будь-який бренд
  category_id    UUID, -- NULL означає будь-яку категорію
  pct_from_revenue NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  pct_from_profit  NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Індекс для швидкого пошуку правил
CREATE INDEX IF NOT EXISTS commission_rules_matching_idx 
  ON commission_rules (tenant_id, user_id, brand_id, category_id);

-- Увімкнення RLS для таблиці правил
ALTER TABLE commission_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "commission_rules_all" ON commission_rules;
CREATE POLICY "commission_rules_all" ON commission_rules FOR ALL USING (true);

-- Додавання унікального поля до salary_payments для запобігання дублюванню нарахувань по замовленню
ALTER TABLE salary_payments 
  ADD COLUMN IF NOT EXISTS commission_source_order_id UUID UNIQUE;

NOTIFY pgrst, 'reload schema';
