-- 111_add_warehouse_to_supplier_price_items.sql
-- Додавання колонки для прив'язки прайсів до складів/джерел


ALTER TABLE supplier_price_items ADD COLUMN IF NOT EXISTS warehouse_name VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_supplier_price_items_warehouse ON supplier_price_items(tenant_id, supplier_id, warehouse_name);

NOTIFY pgrst, 'reload schema';
