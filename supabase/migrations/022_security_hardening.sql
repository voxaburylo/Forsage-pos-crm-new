-- 022_security_hardening.sql
-- Фінальне зміцнення безпеки:
--   1. Helper FUNCTION для tenant_id з JWT
--   2. RLS на всі таблиці з tenant_id фільтрацією
--   3. Ввімкнено RLS на shop_settings, audit_log, users

-- ============================================================
-- 1. Helper: Отримує tenant_id поточного користувача з JWT
--    Падає до MVP_TENANT_ID якщо не знайдено в метаданих
-- ============================================================
CREATE SCHEMA IF NOT EXISTS app;
CREATE OR REPLACE FUNCTION app.user_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID,
    '00000000-0000-0000-0000-000000000001'::UUID
  );
$$;

-- ============================================================
-- 2. Функція перевірки: чи JWT роль має доступ до operations
-- ============================================================
CREATE OR REPLACE FUNCTION app.has_role(required_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'role') = ANY(required_roles),
    false
  );
$$;

-- ============================================================
-- 3. Очищаємо старі політики та створюємо нові
-- ============================================================

-- ---------- PRODUCTS ----------
DROP POLICY IF EXISTS "products_tenant_select" ON products;
DROP POLICY IF EXISTS "products_tenant_insert" ON products;
DROP POLICY IF EXISTS "products_tenant_update" ON products;
DROP POLICY IF EXISTS "products_tenant_delete" ON products;

CREATE POLICY "products_select" ON products
  FOR SELECT USING (tenant_id = app.user_tenant_id() AND deleted_at IS NULL);

CREATE POLICY "products_insert" ON products
  FOR INSERT WITH CHECK (tenant_id = app.user_tenant_id());

CREATE POLICY "products_update" ON products
  FOR UPDATE USING (tenant_id = app.user_tenant_id());

-- ---------- CATEGORIES ----------
DROP POLICY IF EXISTS "categories_tenant_all" ON categories;
CREATE POLICY "categories_all" ON categories
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- BRANDS ----------
DROP POLICY IF EXISTS "brands_tenant_all" ON brands;
CREATE POLICY "brands_all" ON brands
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- CUSTOMERS ----------
DROP POLICY IF EXISTS "customers_tenant_select" ON customers;
DROP POLICY IF EXISTS "customers_tenant_insert" ON customers;
DROP POLICY IF EXISTS "customers_tenant_update" ON customers;

CREATE POLICY "customers_select" ON customers
  FOR SELECT USING (tenant_id = app.user_tenant_id() AND deleted_at IS NULL);

CREATE POLICY "customers_insert" ON customers
  FOR INSERT WITH CHECK (tenant_id = app.user_tenant_id());

CREATE POLICY "customers_update" ON customers
  FOR UPDATE USING (tenant_id = app.user_tenant_id());

-- ---------- CUSTOMER_VEHICLES ----------
DROP POLICY IF EXISTS "customer_vehicles_tenant_all" ON customer_vehicles;
CREATE POLICY "customer_vehicles_all" ON customer_vehicles
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- SUPPLIERS ----------
DROP POLICY IF EXISTS "suppliers_tenant_select" ON suppliers;
DROP POLICY IF EXISTS "suppliers_tenant_insert" ON suppliers;
DROP POLICY IF EXISTS "suppliers_tenant_update" ON suppliers;

CREATE POLICY "suppliers_select" ON suppliers
  FOR SELECT USING (tenant_id = app.user_tenant_id() AND deleted_at IS NULL);

CREATE POLICY "suppliers_insert" ON suppliers
  FOR INSERT WITH CHECK (tenant_id = app.user_tenant_id());

CREATE POLICY "suppliers_update" ON suppliers
  FOR UPDATE USING (tenant_id = app.user_tenant_id());

-- ---------- SHIFTS ----------
DROP POLICY IF EXISTS "shifts_tenant_all" ON shifts;
CREATE POLICY "shifts_all" ON shifts
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- SALES ----------
DROP POLICY IF EXISTS "sales_tenant_all" ON sales;
CREATE POLICY "sales_all" ON sales
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- SALE_ITEMS ----------
DROP POLICY IF EXISTS "sale_items_tenant_all" ON sale_items;
CREATE POLICY "sale_items_all" ON sale_items
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- RETURNS ----------
DROP POLICY IF EXISTS "returns_tenant_all" ON returns;
CREATE POLICY "returns_all" ON returns
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- RETURN_ITEMS ----------
DROP POLICY IF EXISTS "tenant_isolation_return_items" ON return_items;
CREATE POLICY "return_items_all" ON return_items
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- SUPPLY_INVOICES ----------
DROP POLICY IF EXISTS "supply_invoices_tenant_all" ON supply_invoices;
CREATE POLICY "supply_invoices_all" ON supply_invoices
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- SUPPLY_INVOICE_ITEMS ----------
DROP POLICY IF EXISTS "supply_invoice_items_tenant_all" ON supply_invoice_items;
CREATE POLICY "supply_invoice_items_all" ON supply_invoice_items
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- INVENTORY_WRITEOFFS ----------
DROP POLICY IF EXISTS "writeoffs_all" ON inventory_writeoffs;
CREATE POLICY "writeoffs_all" ON inventory_writeoffs
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- INVENTORY_WRITEOFF_ITEMS ----------
DROP POLICY IF EXISTS "writeoff_items_all" ON inventory_writeoff_items;
CREATE POLICY "writeoff_items_all" ON inventory_writeoff_items
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ============================================================
-- 4. Ввімкнено RLS на таблицях без нього
-- ============================================================

-- ---------- SHOP_SETTINGS ----------
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "shop_settings_all" ON shop_settings;
CREATE POLICY "shop_settings_all" ON shop_settings
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- AUDIT_LOG ----------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_log_select" ON audit_log;
CREATE POLICY "audit_log_all" ON audit_log
  FOR ALL USING (tenant_id = app.user_tenant_id());

-- ---------- USERS (таблиця — якщо існує) ----------
-- Примітка: users — це таблиця з seed/даними користувачів,
-- не плутати з auth.users (системна таблиця Supabase Auth).
-- Якщо окремої таблиці users немає — пропускаємо, вона не створена в міграціях.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') THEN
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "users_all" ON users;
    CREATE POLICY "users_all" ON users
      FOR ALL USING (tenant_id = app.user_tenant_id());
  END IF;
END;
$$;
