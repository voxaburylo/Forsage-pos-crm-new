-- 019_products_low_stock_view.sql
-- View to expose products whose stock is below or equal to reorder point

CREATE OR REPLACE VIEW products_low_stock AS
SELECT *
FROM products
WHERE deleted_at IS NULL
  AND qty_on_hand <= reorder_point;

ALTER VIEW products_low_stock SET (security_invoker = on);
