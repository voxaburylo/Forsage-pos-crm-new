-- Власна база OE та крос-номерів товарів.
-- Номери зберігаються окремо від складської картки, тому один товар може
-- мати необмежену кількість пошукових номерів із зазначенням джерела.

CREATE TABLE IF NOT EXISTS product_cross_numbers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  number            VARCHAR(100) NOT NULL,
  normalized_number VARCHAR(100) NOT NULL,
  number_type       VARCHAR(20) NOT NULL DEFAULT 'cross'
                      CHECK (number_type IN ('cross', 'oe', 'supplier', 'other')),
  brand             VARCHAR(100),
  source            VARCHAR(200) NOT NULL DEFAULT 'Внесено менеджером',
  is_verified       BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, normalized_number)
);

CREATE INDEX IF NOT EXISTS idx_product_cross_numbers_lookup
  ON product_cross_numbers (tenant_id, normalized_number);

CREATE INDEX IF NOT EXISTS idx_product_cross_numbers_product
  ON product_cross_numbers (tenant_id, product_id);

ALTER TABLE product_cross_numbers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_cross_numbers_all" ON product_cross_numbers;
CREATE POLICY "product_cross_numbers_all"
  ON product_cross_numbers FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE product_cross_numbers IS
  'OE, OEM, крос-номери та номери постачальників, що ведуть до складського товару';
COMMENT ON COLUMN product_cross_numbers.source IS
  'Звідки отримано зв''язок: менеджер, постачальник, каталог або імпорт';

NOTIFY pgrst, 'reload schema';
