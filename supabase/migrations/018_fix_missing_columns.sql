-- Migration 018: Додати oem_number до products (використовується в searchService)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS oem_number VARCHAR(100) DEFAULT '';

-- View для доступного залишку (використовується enrichWithAvailability)
CREATE OR REPLACE VIEW products_available AS
SELECT
  p.id AS product_id,
  p.qty_on_hand,
  COALESCE(SUM(r.qty) FILTER (WHERE r.released_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())), 0) AS qty_reserved,
  p.qty_on_hand - COALESCE(SUM(r.qty) FILTER (WHERE r.released_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())), 0) AS qty_available
FROM products p
LEFT JOIN inventory_reserves r ON r.product_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.qty_on_hand;

-- Normalized supplier article index fix
ALTER TABLE product_supplier_codes
  ADD COLUMN IF NOT EXISTS normalized_supplier_article VARCHAR(100) NOT NULL DEFAULT '';
