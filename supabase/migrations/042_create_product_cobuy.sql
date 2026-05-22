-- 042_create_product_cobuy.sql
-- Супутні товари (Cross-sell / Co-buy)

CREATE TABLE IF NOT EXISTS product_cobuy (
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, recommended_product_id)
);

ALTER TABLE product_cobuy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_cobuy_all" ON product_cobuy FOR ALL USING (true);
