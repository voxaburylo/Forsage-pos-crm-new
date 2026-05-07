-- ============================================================
-- Форсаж CRM — RLS политики безопасности
-- Миграция 002: Row Level Security для всех таблиц
-- ============================================================

-- PRODUCTS
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "products_tenant_select" ON products
  FOR SELECT USING (deleted_at IS NULL);

CREATE POLICY "products_tenant_insert" ON products
  FOR INSERT WITH CHECK (true);

CREATE POLICY "products_tenant_update" ON products
  FOR UPDATE USING (true);

CREATE POLICY "products_tenant_delete" ON products
  FOR UPDATE USING (true);

-- CATEGORIES
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categories_tenant_all" ON categories
  FOR ALL USING (true);

-- BRANDS
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brands_tenant_all" ON brands
  FOR ALL USING (true);

-- CUSTOMERS
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_tenant_select" ON customers
  FOR SELECT USING (deleted_at IS NULL);

CREATE POLICY "customers_tenant_insert" ON customers
  FOR INSERT WITH CHECK (true);

CREATE POLICY "customers_tenant_update" ON customers
  FOR UPDATE USING (true);

-- CUSTOMER_VEHICLES
ALTER TABLE customer_vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_vehicles_tenant_all" ON customer_vehicles
  FOR ALL USING (true);

-- SUPPLIERS
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppliers_tenant_select" ON suppliers
  FOR SELECT USING (deleted_at IS NULL);

CREATE POLICY "suppliers_tenant_insert" ON suppliers
  FOR INSERT WITH CHECK (true);

CREATE POLICY "suppliers_tenant_update" ON suppliers
  FOR UPDATE USING (true);

-- SHIFTS
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shifts_tenant_all" ON shifts
  FOR ALL USING (true);

-- SALES
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_tenant_all" ON sales
  FOR ALL USING (true);

-- SALE_ITEMS
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sale_items_tenant_all" ON sale_items
  FOR ALL USING (true);

-- RETURNS
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "returns_tenant_all" ON returns
  FOR ALL USING (true);

-- SUPPLY_INVOICES
ALTER TABLE supply_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supply_invoices_tenant_all" ON supply_invoices
  FOR ALL USING (true);

-- SUPPLY_INVOICE_ITEMS
ALTER TABLE supply_invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supply_invoice_items_tenant_all" ON supply_invoice_items
  FOR ALL USING (true);
