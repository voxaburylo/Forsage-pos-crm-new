-- 017_product_photos.sql
-- Adds a primary photo URL to products and creates a gallery table for additional photos

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);

COMMENT ON COLUMN products.photo_url IS 'Main product photo (URL)';

CREATE TABLE IF NOT EXISTS product_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_photos_product ON product_photos(product_id);

ALTER TABLE product_photos ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'product_photos' AND policyname = 'product_photos_all'
  ) THEN
    CREATE POLICY product_photos_all ON product_photos FOR ALL USING (true);
  END IF;
END $$;