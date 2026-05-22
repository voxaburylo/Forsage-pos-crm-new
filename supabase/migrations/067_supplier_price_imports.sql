-- 067_supplier_price_imports.sql
-- Створення таблиці для пакетного імпорту прайс-листів постачальників

CREATE TABLE IF NOT EXISTS supplier_price_imports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  filename       VARCHAR(255) NOT NULL,
  status         VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  total_rows     INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  errors_log     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Увімкнення RLS
ALTER TABLE supplier_price_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supplier_price_imports_all" ON supplier_price_imports;
CREATE POLICY "supplier_price_imports_all" ON supplier_price_imports FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';
