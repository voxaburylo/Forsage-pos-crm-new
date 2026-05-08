-- ============================================================
-- Форсаж CRM — налаштування магазину
-- Міграція 005: таблиця shop_settings (один рядок на магазин)
-- ============================================================

CREATE TABLE shop_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  shop_name           VARCHAR(200) NOT NULL DEFAULT 'Форсаж',
  shop_address        TEXT,
  phone               VARCHAR(30),
  max_discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 20,
  allow_negative_qty  BOOLEAN NOT NULL DEFAULT true,
  return_days         INTEGER NOT NULL DEFAULT 14,
  currency            VARCHAR(10) NOT NULL DEFAULT 'UAH',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- Початковий рядок для MVP-магазину
INSERT INTO shop_settings (shop_name) VALUES ('Форсаж');

-- RLS
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_settings_all" ON shop_settings FOR ALL USING (true);
