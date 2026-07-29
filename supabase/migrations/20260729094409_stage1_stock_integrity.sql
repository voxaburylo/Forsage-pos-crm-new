-- Stage 1 stock integrity: authoritative movement ledger and safe supply posting/cancellation.

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  qty_delta NUMERIC(12,3) NOT NULL,
  qty_after NUMERIC(12,3) NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_tenant_time
  ON public.inventory_movements (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_time
  ON public.inventory_movements (tenant_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_source
  ON public.inventory_movements (tenant_id, source_type, source_id);

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_movements_tenant_select ON public.inventory_movements;
CREATE POLICY inventory_movements_tenant_select ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT app.user_tenant_id()));

DROP POLICY IF EXISTS inventory_movements_staff_insert ON public.inventory_movements;
CREATE POLICY inventory_movements_staff_insert ON public.inventory_movements
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = (SELECT app.user_tenant_id())
    AND (SELECT app.has_role(ARRAY['owner', 'admin', 'manager', 'storekeeper', 'cashier']))
  );

GRANT SELECT, INSERT ON public.inventory_movements TO authenticated;
GRANT ALL ON public.inventory_movements TO service_role;

CREATE OR REPLACE FUNCTION public.record_inventory_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_type TEXT;
  v_source_id TEXT;
BEGIN
  IF NEW.qty_on_hand IS NOT DISTINCT FROM OLD.qty_on_hand THEN
    RETURN NEW;
  END IF;

  v_source_type := NULLIF(current_setting('app.stock_source_type', true), '');
  v_source_id := NULLIF(current_setting('app.stock_source_id', true), '');

  INSERT INTO public.inventory_movements (
    tenant_id, product_id, source_type, source_id,
    qty_delta, qty_after, unit_cost, notes
  ) VALUES (
    NEW.tenant_id,
    NEW.id,
    COALESCE(v_source_type, 'system'),
    v_source_id,
    NEW.qty_on_hand - OLD.qty_on_hand,
    NEW.qty_on_hand,
    GREATEST(COALESCE(NEW.purchase_price, 0), 0),
    CASE WHEN v_source_type IS NULL THEN 'Автоматичний запис зміни залишку' ELSE NULL END
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_inventory_movement() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_record_inventory_movement ON public.products;
CREATE TRIGGER trg_record_inventory_movement
AFTER UPDATE OF qty_on_hand ON public.products
FOR EACH ROW
WHEN (OLD.qty_on_hand IS DISTINCT FROM NEW.qty_on_hand)
EXECUTE FUNCTION public.record_inventory_movement();

-- Establish a trustworthy opening point for every existing balance.
INSERT INTO public.inventory_movements (
  tenant_id, product_id, source_type, source_id,
  qty_delta, qty_after, unit_cost, notes, created_at
)
SELECT
  p.tenant_id, p.id, 'opening_balance', NULL,
  p.qty_on_hand, p.qty_on_hand, GREATEST(COALESCE(p.purchase_price, 0), 0),
  'Початковий залишок під час запуску журналу рухів', NOW()
FROM public.products p
WHERE p.qty_on_hand <> 0
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.tenant_id = p.tenant_id
      AND m.product_id = p.id
      AND m.source_type = 'opening_balance'
  );

SELECT set_config('app.stock_source_type', 'legacy_deleted_cleanup', true);
SELECT set_config('app.stock_source_id', '', true);
UPDATE public.products
SET qty_on_hand = 0, updated_at = NOW()
WHERE deleted_at IS NOT NULL AND qty_on_hand <> 0;
SELECT set_config('app.stock_source_type', '', true);

ALTER TABLE public.shop_settings
  ALTER COLUMN allow_negative_qty SET DEFAULT false;

CREATE OR REPLACE FUNCTION public.post_supply_invoice(
  p_invoice_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_status TEXT;
  v_tenant_id UUID;
  v_item RECORD;
  v_missing RECORD;
  v_item_count INTEGER;
BEGIN
  SELECT status, tenant_id
  INTO v_status, v_tenant_id
  FROM public.supply_invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Накладну не знайдено';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'INVOICE_ALREADY_POSTED: Накладну вже проведено або скасовано';
  END IF;

  SELECT COUNT(*) INTO v_item_count
  FROM public.supply_invoice_items
  WHERE invoice_id = p_invoice_id AND tenant_id = v_tenant_id;
  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'INVOICE_EMPTY: Додайте хоча б один товар у накладну';
  END IF;

  SELECT ii.product_id
  INTO v_missing
  FROM public.supply_invoice_items ii
  LEFT JOIN public.products p
    ON p.id = ii.product_id
   AND p.tenant_id = v_tenant_id
   AND p.deleted_at IS NULL
  WHERE ii.invoice_id = p_invoice_id
    AND ii.tenant_id = v_tenant_id
    AND p.id IS NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар % відсутній або видалений', v_missing.product_id;
  END IF;

  PERFORM set_config('app.stock_source_type', 'supply_invoice', true);
  PERFORM set_config('app.stock_source_id', p_invoice_id::TEXT, true);

  FOR v_item IN
    SELECT ii.product_id, ii.qty, ii.purchase_price
    FROM public.supply_invoice_items ii
    WHERE ii.invoice_id = p_invoice_id AND ii.tenant_id = v_tenant_id
    ORDER BY ii.id
  LOOP
    PERFORM 1
    FROM public.products
    WHERE id = v_item.product_id
      AND tenant_id = v_tenant_id
      AND deleted_at IS NULL
    FOR UPDATE;

    UPDATE public.products
    SET qty_on_hand = qty_on_hand + v_item.qty,
        purchase_price = v_item.purchase_price,
        updated_at = NOW()
    WHERE id = v_item.product_id AND tenant_id = v_tenant_id;
  END LOOP;

  UPDATE public.supply_invoices
  SET status = 'posted', posted_at = NOW(), posted_by = p_user_id, updated_at = NOW()
  WHERE id = p_invoice_id AND tenant_id = v_tenant_id;

  PERFORM set_config('app.stock_source_type', '', true);
  PERFORM set_config('app.stock_source_id', '', true);
  RETURN (SELECT row_to_json(i)::JSONB FROM (SELECT * FROM public.supply_invoices WHERE id = p_invoice_id) i);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_supply_invoice(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_status TEXT;
  v_tenant_id UUID;
  v_item RECORD;
  v_shortage RECORD;
  v_missing RECORD;
BEGIN
  SELECT status, tenant_id
  INTO v_status, v_tenant_id
  FROM public.supply_invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Накладну не знайдено';
  END IF;
  IF v_status = 'cancelled' THEN
    RETURN (SELECT row_to_json(i)::JSONB FROM (SELECT * FROM public.supply_invoices WHERE id = p_invoice_id) i);
  END IF;

  IF v_status = 'posted' THEN
    SELECT ii.product_id
    INTO v_missing
    FROM public.supply_invoice_items ii
    LEFT JOIN public.products p
      ON p.id = ii.product_id
     AND p.tenant_id = v_tenant_id
     AND p.deleted_at IS NULL
    WHERE ii.invoice_id = p_invoice_id
      AND ii.tenant_id = v_tenant_id
      AND p.id IS NULL
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар % відсутній або видалений', v_missing.product_id;
    END IF;

    PERFORM 1
    FROM public.products p
    JOIN (
      SELECT product_id
      FROM public.supply_invoice_items
      WHERE invoice_id = p_invoice_id AND tenant_id = v_tenant_id
      GROUP BY product_id
    ) required ON required.product_id = p.id
    WHERE p.tenant_id = v_tenant_id
    ORDER BY p.id
    FOR UPDATE OF p;

    SELECT p.id AS product_id, p.name, p.qty_on_hand, required.qty
    INTO v_shortage
    FROM public.products p
    JOIN (
      SELECT product_id, SUM(qty) AS qty
      FROM public.supply_invoice_items
      WHERE invoice_id = p_invoice_id AND tenant_id = v_tenant_id
      GROUP BY product_id
    ) required ON required.product_id = p.id
    WHERE p.tenant_id = v_tenant_id
      AND p.qty_on_hand < required.qty
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'INVOICE_STOCK_USED: Неможливо скасувати накладну: товар "%" уже продано або списано (є %, потрібно %)',
        v_shortage.name, v_shortage.qty_on_hand, v_shortage.qty;
    END IF;

    PERFORM set_config('app.stock_source_type', 'supply_invoice_cancel', true);
    PERFORM set_config('app.stock_source_id', p_invoice_id::TEXT, true);

    FOR v_item IN
      SELECT product_id, qty
      FROM public.supply_invoice_items
      WHERE invoice_id = p_invoice_id AND tenant_id = v_tenant_id
      ORDER BY id
    LOOP
      UPDATE public.products
      SET qty_on_hand = qty_on_hand - v_item.qty,
          updated_at = NOW()
      WHERE id = v_item.product_id AND tenant_id = v_tenant_id;
    END LOOP;
  END IF;

  UPDATE public.supply_invoices
  SET status = 'cancelled', updated_at = NOW()
  WHERE id = p_invoice_id AND tenant_id = v_tenant_id;

  PERFORM set_config('app.stock_source_type', '', true);
  PERFORM set_config('app.stock_source_id', '', true);
  RETURN (SELECT row_to_json(i)::JSONB FROM (SELECT * FROM public.supply_invoices WHERE id = p_invoice_id) i);
END;
$$;

NOTIFY pgrst, 'reload schema';