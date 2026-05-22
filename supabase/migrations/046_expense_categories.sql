-- 046_expense_categories.sql
-- Статті витрат (OPEX) для розрахунку чистого прибутку

CREATE TABLE IF NOT EXISTS expense_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  name       VARCHAR(200) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cash_operations ADD COLUMN IF NOT EXISTS expense_category_id UUID REFERENCES expense_categories(id);

-- Базові категорії
INSERT INTO expense_categories (name) VALUES
  ('Оренда'), ('Комунальні'), ('Зарплата'),
  ('Інтернет та зв''язок'), ('Транспорт'), ('Реклама'),
  ('Господарські'), ('Податки'), ('Інше')
ON CONFLICT DO NOTHING;

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_categories_all" ON expense_categories FOR ALL USING (true);
