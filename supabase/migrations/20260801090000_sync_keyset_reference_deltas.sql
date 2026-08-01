-- Stable desktop delta sync.
--
-- Business timestamps (created_at/completed_at) remain historical facts.  The
-- updated_at columns below describe when the server accepted a change and are
-- used exclusively by the pull cursor.

-- A destructive tenant reset cannot be represented by thousands of ordinary
-- tombstones (sales and several journals are append-only). Keep a generation
-- marker outside the reset delete list so clients can atomically discard the
-- previous server-derived cache and bootstrap the new generation.
CREATE TABLE IF NOT EXISTS public.sync_tenant_generations (
  tenant_id UUID PRIMARY KEY,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  reset_at TIMESTAMPTZ,
  resetting_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.sync_tenant_generations
  ADD COLUMN IF NOT EXISTS resetting_at TIMESTAMPTZ;

INSERT INTO public.sync_tenant_generations (tenant_id, generation, reset_at, updated_at)
SELECT DISTINCT tenant_id, 0, NULL::TIMESTAMPTZ, clock_timestamp()
FROM public.shop_settings
ON CONFLICT (tenant_id) DO NOTHING;

ALTER TABLE public.sync_tenant_generations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_tenant_generations_tenant_policy ON public.sync_tenant_generations;
CREATE POLICY sync_tenant_generations_tenant_policy
  ON public.sync_tenant_generations
  FOR SELECT TO authenticated
  USING (tenant_id = app.user_tenant_id());
REVOKE ALL ON TABLE public.sync_tenant_generations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sync_tenant_generations TO service_role;

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.product_aliases
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.product_cross_numbers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.customer_cars
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.customer_vehicles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
UPDATE public.customer_vehicles
SET updated_at = COALESCE(updated_at, created_at, '1970-01-01 00:00:00+00'::timestamptz)
WHERE updated_at IS NULL;
ALTER TABLE public.customer_vehicles
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.order_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.bonus_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.customer_deposit_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.cash_operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.salary_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.warehouse_movements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.inventory_writeoffs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.inventory_reserves ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.inventory_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.customer_returns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00';

-- Repair orphaned active children left by legacy hard-delete paths before the
-- new tombstone contract becomes authoritative.
UPDATE public.product_barcodes AS ref
SET deleted_at = NOW(), updated_at = NOW()
FROM public.products AS parent
WHERE ref.tenant_id = parent.tenant_id
  AND ref.product_id = parent.id
  AND ref.deleted_at IS NULL
  AND (parent.deleted_at IS NOT NULL OR parent.is_active = false);

UPDATE public.product_aliases AS ref
SET deleted_at = NOW(), updated_at = NOW()
FROM public.products AS parent
WHERE ref.tenant_id = parent.tenant_id
  AND ref.product_id = parent.id
  AND ref.deleted_at IS NULL
  AND (parent.deleted_at IS NOT NULL OR parent.is_active = false);

UPDATE public.product_cross_numbers AS ref
SET deleted_at = NOW(), updated_at = NOW()
FROM public.products AS parent
WHERE ref.tenant_id = parent.tenant_id
  AND ref.product_id = parent.id
  AND ref.deleted_at IS NULL
  AND (parent.deleted_at IS NOT NULL OR parent.is_active = false);

UPDATE public.customer_cars AS car
SET deleted_at = NOW(), updated_at = NOW()
FROM public.customers AS customer
WHERE car.tenant_id = customer.tenant_id
  AND car.customer_id = customer.id
  AND car.deleted_at IS NULL
  AND customer.deleted_at IS NOT NULL;
UPDATE public.customer_vehicles AS vehicle
SET deleted_at = NOW(), updated_at = NOW()
FROM public.customers AS customer
WHERE vehicle.tenant_id = customer.tenant_id
  AND vehicle.customer_id = customer.id
  AND vehicle.deleted_at IS NULL
  AND customer.deleted_at IS NOT NULL;

-- The constant legacy timestamp is a metadata-only default on supported
-- PostgreSQL versions: existing rows do not need a table-wide UPDATE and do
-- not flood the first delta. Future inserts use the real server time.
ALTER TABLE public.categories ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.brands ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.product_aliases ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.product_cross_numbers ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.product_barcodes ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.customer_cars ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.customer_vehicles ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.order_payments ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.bonus_transactions ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.customer_deposit_transactions ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.cash_operations ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.salary_payments ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.warehouse_movements ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.inventory_writeoffs ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.inventory_reserves ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.inventory_sessions ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.customer_returns ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.shifts ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.products ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.customers ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.suppliers ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.sales ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.customer_orders ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.supply_invoices ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.supplier_payments ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.supplier_price_items ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE public.supplier_price_imports ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
-- Stamp every insert/update at the actual database statement. This keeps long
-- transactions from committing rows behind an already-issued sync cursor.
CREATE OR REPLACE FUNCTION public.sync_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_touch_updated_at() TO service_role;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'products', 'customers', 'suppliers', 'sales', 'customer_orders',
    'supply_invoices', 'supplier_price_items', 'supplier_price_imports',
    'categories', 'brands', 'product_barcodes', 'product_aliases',
    'product_cross_numbers', 'customer_cars', 'customer_vehicles', 'order_payments',
    'bonus_transactions', 'customer_deposit_transactions', 'cash_operations',
    'salary_payments', 'warehouse_movements', 'inventory_writeoffs',
    'inventory_sessions', 'inventory_items', 'inventory_reserves',
    'customer_returns', 'shifts', 'supplier_payments'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_touch_updated_at ON public.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_sync_touch_updated_at BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.sync_touch_updated_at()',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_touch_deleted_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.deleted_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_touch_deleted_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_touch_deleted_at() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_touch_deleted_at ON public.sync_deletions;
CREATE TRIGGER trg_sync_touch_deleted_at
BEFORE INSERT OR UPDATE ON public.sync_deletions
FOR EACH ROW EXECUTE FUNCTION public.sync_touch_deleted_at();

-- Soft-deleted brands and cars must not reserve their human identifiers.
ALTER TABLE public.brands DROP CONSTRAINT IF EXISTS brands_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_brands_tenant_name_active
  ON public.brands (tenant_id, name)
  WHERE deleted_at IS NULL;
-- Legacy imports may contain the same VIN under several duplicate customer
-- cards even though the application treats a VIN as one current vehicle. Keep
-- the newest association active and retain every older row as a sync-visible
-- tombstone instead of deleting history.
UPDATE public.customer_cars
SET vin = NULLIF(UPPER(BTRIM(vin)), ''), updated_at = clock_timestamp()
WHERE vin IS DISTINCT FROM NULLIF(UPPER(BTRIM(vin)), '');

WITH ranked_vins AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, vin
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS position
  FROM public.customer_cars
  WHERE vin IS NOT NULL AND deleted_at IS NULL
)
UPDATE public.customer_cars AS car
SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
FROM ranked_vins AS ranked
WHERE car.id = ranked.id AND ranked.position > 1;

ALTER TABLE public.customer_cars DROP CONSTRAINT IF EXISTS customer_cars_vin_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_cars_tenant_vin_active
  ON public.customer_cars (tenant_id, (UPPER(BTRIM(vin))))
  WHERE NULLIF(BTRIM(vin), '') IS NOT NULL AND deleted_at IS NULL;

-- Equality tenant filter first, then the timestamp range and deterministic id
-- tie-breaker used by keyset pagination.
CREATE INDEX IF NOT EXISTS idx_sync_categories_tenant_updated_id ON public.categories (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_brands_tenant_updated_id ON public.brands (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_barcodes_tenant_updated_id ON public.product_barcodes (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_aliases_tenant_updated_id ON public.product_aliases (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_cross_tenant_updated_id ON public.product_cross_numbers (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customer_cars_tenant_updated_id ON public.customer_cars (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customer_vehicles_tenant_updated_id ON public.customer_vehicles (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_barcodes_parent_active
  ON public.product_barcodes (tenant_id, product_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_product_aliases_parent_active
  ON public.product_aliases (tenant_id, product_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_product_cross_parent_active
  ON public.product_cross_numbers (tenant_id, product_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_customer_cars_parent_active
  ON public.customer_cars (tenant_id, customer_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_customer_vehicles_parent_active
  ON public.customer_vehicles (tenant_id, customer_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_inventory_items_updated_id ON public.inventory_items (updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_order_payments_tenant_updated_id ON public.order_payments (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_bonus_transactions_tenant_updated_id ON public.bonus_transactions (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_deposit_transactions_tenant_updated_id ON public.customer_deposit_transactions (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_cash_operations_tenant_updated_id ON public.cash_operations (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_salary_payments_tenant_updated_id ON public.salary_payments (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_warehouse_movements_tenant_updated_id ON public.warehouse_movements (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_writeoffs_tenant_updated_id ON public.inventory_writeoffs (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_reserves_tenant_updated_id ON public.inventory_reserves (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_inventory_sessions_tenant_updated_id ON public.inventory_sessions (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customer_returns_tenant_updated_id ON public.customer_returns (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_shifts_tenant_updated_id ON public.shifts (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_products_tenant_updated_id ON public.products (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customers_tenant_updated_id ON public.customers (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_suppliers_tenant_updated_id ON public.suppliers (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sales_tenant_updated_id ON public.sales (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_orders_tenant_updated_id ON public.customer_orders (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_supply_invoices_tenant_updated_id ON public.supply_invoices (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_supplier_payments_tenant_updated_id ON public.supplier_payments (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_supplier_prices_tenant_updated_id ON public.supplier_price_items (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_supplier_imports_tenant_updated_id ON public.supplier_price_imports (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_deletions_tenant_type_time_id ON public.sync_deletions (tenant_id, entity_type, deleted_at, entity_id);

-- The canonical product trigger must publish barcode removals as soft deletes;
-- otherwise an incremental desktop pull cannot learn that an index row vanished.
CREATE OR REPLACE FUNCTION public.sync_product_primary_barcode_index()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_indexed_product_id UUID;
  v_stamp TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.barcode IS NOT NULL
     AND OLD.barcode IS DISTINCT FROM NEW.barcode THEN
    UPDATE public.product_barcodes
       SET deleted_at = v_stamp, updated_at = v_stamp
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id
       AND barcode = OLD.barcode
       AND is_primary = true
       AND deleted_at IS NULL;
  END IF;

  IF NEW.deleted_at IS NOT NULL OR NEW.is_active = false THEN
    UPDATE public.product_barcodes
       SET deleted_at = v_stamp, updated_at = v_stamp
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id
       AND deleted_at IS NULL;
    UPDATE public.product_aliases
       SET deleted_at = v_stamp, updated_at = v_stamp
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id
       AND deleted_at IS NULL;
    UPDATE public.product_cross_numbers
       SET deleted_at = v_stamp, updated_at = v_stamp
     WHERE tenant_id = NEW.tenant_id
       AND product_id = NEW.id
       AND deleted_at IS NULL;
    RETURN NEW;
  END IF;

  IF NULLIF(BTRIM(COALESCE(NEW.barcode, '')), '') IS NOT NULL THEN
    INSERT INTO public.product_barcodes (
      id, tenant_id, product_id, barcode, barcode_type, is_primary,
      created_at, updated_at, deleted_at
    ) VALUES (
      gen_random_uuid(), NEW.tenant_id, NEW.id, BTRIM(NEW.barcode), 'ean13', true,
      v_stamp, v_stamp, NULL
    )
    ON CONFLICT (tenant_id, barcode) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      barcode_type = EXCLUDED.barcode_type,
      is_primary = true,
      updated_at = EXCLUDED.updated_at,
      deleted_at = NULL
    WHERE product_barcodes.product_id = EXCLUDED.product_id
       OR product_barcodes.deleted_at IS NOT NULL
    RETURNING product_id INTO v_indexed_product_id;

    IF v_indexed_product_id IS NULL THEN
      RAISE EXCEPTION 'BARCODE_ALREADY_EXISTS: Штрихкод % вже належить іншому товару', BTRIM(NEW.barcode);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_product_primary_barcode_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_product_primary_barcode_index() TO service_role;

NOTIFY pgrst, 'reload schema';
