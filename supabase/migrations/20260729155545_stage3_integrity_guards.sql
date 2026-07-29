-- Stage 3: make document state transitions single-path, tenant-safe and replay-safe.

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS exchange_source_order_id UUID REFERENCES public.customer_orders(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_order_exchange_source
  ON public.customer_orders(tenant_id, exchange_source_order_id)
  WHERE exchange_source_order_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.update_customer_order_status(
  p_tenant_id UUID,
  p_order_id UUID,
  p_status VARCHAR,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $order_status$
DECLARE
  v_current_status TEXT;
BEGIN
  IF p_status NOT IN ('lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready') THEN
    RAISE EXCEPTION 'ORDER_STATUS_REQUIRES_DEDICATED_ACTION';
  END IF;

  SELECT status INTO v_current_status
  FROM public.customer_orders
  WHERE id = p_order_id AND tenant_id = p_tenant_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Замовлення не знайдено'; END IF;

  IF v_current_status IN ('completed', 'canceled', 'archived') THEN
    RAISE EXCEPTION 'ORDER_IMMUTABLE';
  END IF;
  IF v_current_status = p_status THEN
    RETURN (SELECT to_jsonb(o) FROM public.customer_orders o
            WHERE o.id = p_order_id AND o.tenant_id = p_tenant_id);
  END IF;

  IF p_status IN ('new', 'in_progress') THEN
    PERFORM public.reserve_order_items(p_tenant_id, p_order_id, p_user_id);
  ELSIF p_status = 'lead' THEN
    UPDATE public.inventory_reserves
    SET released_at = COALESCE(released_at, NOW())
    WHERE tenant_id = p_tenant_id AND order_id = p_order_id AND released_at IS NULL;
  END IF;

  UPDATE public.customer_orders
  SET status = p_status, updated_at = NOW()
  WHERE id = p_order_id AND tenant_id = p_tenant_id;

  RETURN (SELECT to_jsonb(o) FROM public.customer_orders o
          WHERE o.id = p_order_id AND o.tenant_id = p_tenant_id);
END;
$order_status$;

CREATE OR REPLACE FUNCTION public.complete_inventory_session(
  p_session_id UUID,
  p_tenant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $inventory_complete$
DECLARE
  v_updated INTEGER := 0;
  v_counted INTEGER := 0;
  v_conflict RECORD;
BEGIN
  PERFORM 1 FROM public.inventory_sessions
  WHERE id = p_session_id AND tenant_id = p_tenant_id AND status = 'in_progress'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_ACTIVE'; END IF;

  SELECT COUNT(*) INTO v_counted
  FROM public.inventory_items i
  JOIN public.products p ON p.id = i.product_id AND p.tenant_id = p_tenant_id
  WHERE i.session_id = p_session_id AND i.was_counted = TRUE;
  IF v_counted = 0 THEN RAISE EXCEPTION 'INVENTORY_EMPTY'; END IF;

  SELECT p.id, p.name, i.expected_stock, p.qty_on_hand
  INTO v_conflict
  FROM public.inventory_items i
  JOIN public.products p ON p.id = i.product_id AND p.tenant_id = p_tenant_id
  WHERE i.session_id = p_session_id
    AND i.was_counted = TRUE
    AND p.qty_on_hand IS DISTINCT FROM i.expected_stock
    AND p.qty_on_hand IS DISTINCT FROM i.counted_stock
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'INVENTORY_STOCK_CONFLICT:%:%:%', v_conflict.id, v_conflict.expected_stock, v_conflict.qty_on_hand;
  END IF;

  PERFORM set_config('app.stock_source_type', 'inventory', TRUE);
  PERFORM set_config('app.stock_source_id', p_session_id::TEXT, TRUE);
  UPDATE public.products p
  SET qty_on_hand = i.counted_stock, updated_at = NOW()
  FROM public.inventory_items i
  WHERE i.session_id = p_session_id
    AND i.product_id = p.id
    AND i.was_counted = TRUE
    AND p.tenant_id = p_tenant_id
    AND p.qty_on_hand IS DISTINCT FROM i.counted_stock;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  UPDATE public.inventory_sessions
  SET status = 'completed', completed_at = NOW()
  WHERE id = p_session_id AND tenant_id = p_tenant_id;

  PERFORM set_config('app.stock_source_type', '', TRUE);
  PERFORM set_config('app.stock_source_id', '', TRUE);
  RETURN jsonb_build_object('items_updated', v_updated);
END;
$inventory_complete$;

CREATE OR REPLACE FUNCTION public.process_writeoff(
  p_tenant_id UUID,
  p_reason VARCHAR,
  p_notes TEXT,
  p_created_by UUID,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $writeoff$
DECLARE
  v_writeoff_id UUID;
  v_item RECORD;
  v_missing RECORD;
  v_shortage RECORD;
  v_allow_negative BOOLEAN := FALSE;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'WRITEOFF_EMPTY';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e
    GROUP BY e->>'product_id' HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'WRITEOFF_DUPLICATE_PRODUCT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e
    WHERE COALESCE((e->>'qty')::NUMERIC, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'WRITEOFF_QTY_INVALID';
  END IF;

  SELECT COALESCE(allow_negative_qty, FALSE) INTO v_allow_negative
  FROM public.shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;

  PERFORM 1
  FROM public.products p
  JOIN (
    SELECT (e->>'product_id')::UUID product_id, SUM((e->>'qty')::NUMERIC) qty
    FROM jsonb_array_elements(p_items) e GROUP BY 1
  ) requested ON requested.product_id = p.id
  WHERE p.tenant_id = p_tenant_id AND p.deleted_at IS NULL
  ORDER BY p.id
  FOR UPDATE OF p;

  SELECT requested.product_id INTO v_missing
  FROM (
    SELECT (e->>'product_id')::UUID product_id
    FROM jsonb_array_elements(p_items) e GROUP BY 1
  ) requested
  LEFT JOIN public.products p
    ON p.id = requested.product_id AND p.tenant_id = p_tenant_id AND p.deleted_at IS NULL
  WHERE p.id IS NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND:%', v_missing.product_id; END IF;

  SELECT p.id product_id, p.name, p.qty_on_hand, requested.qty INTO v_shortage
  FROM public.products p
  JOIN (
    SELECT (e->>'product_id')::UUID product_id, SUM((e->>'qty')::NUMERIC) qty
    FROM jsonb_array_elements(p_items) e GROUP BY 1
  ) requested ON requested.product_id = p.id
  WHERE p.tenant_id = p_tenant_id AND p.qty_on_hand < requested.qty
  LIMIT 1;
  IF FOUND AND NOT v_allow_negative THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', v_shortage.name, v_shortage.qty_on_hand, v_shortage.qty;
  END IF;

  INSERT INTO public.inventory_writeoffs (tenant_id, reason, notes, created_by)
  VALUES (p_tenant_id, p_reason::VARCHAR(50), p_notes, p_created_by)
  RETURNING id INTO v_writeoff_id;

  PERFORM set_config('app.stock_source_type', 'writeoff', TRUE);
  PERFORM set_config('app.stock_source_id', v_writeoff_id::TEXT, TRUE);
  FOR v_item IN
    SELECT p.id product_id, requested.qty, p.purchase_price
    FROM public.products p
    JOIN (
      SELECT (e->>'product_id')::UUID product_id, SUM((e->>'qty')::NUMERIC) qty
      FROM jsonb_array_elements(p_items) e GROUP BY 1
    ) requested ON requested.product_id = p.id
    WHERE p.tenant_id = p_tenant_id
    ORDER BY p.id
  LOOP
    INSERT INTO public.inventory_writeoff_items (writeoff_id, product_id, qty, cost_kopecks)
    VALUES (v_writeoff_id, v_item.product_id, v_item.qty, ROUND(v_item.purchase_price * v_item.qty)::INTEGER);
    UPDATE public.products
    SET qty_on_hand = qty_on_hand - v_item.qty, updated_at = NOW()
    WHERE id = v_item.product_id AND tenant_id = p_tenant_id;
  END LOOP;
  PERFORM set_config('app.stock_source_type', '', TRUE);
  PERFORM set_config('app.stock_source_id', '', TRUE);

  RETURN (SELECT to_jsonb(w) FROM public.inventory_writeoffs w
          WHERE w.id = v_writeoff_id AND w.tenant_id = p_tenant_id);
END;
$writeoff$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_writeoff_item_product
  ON public.inventory_writeoff_items(writeoff_id, product_id);

CREATE OR REPLACE FUNCTION public.guard_terminal_order_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $terminal_order_guard$
BEGIN
  IF OLD.status IN ('completed', 'canceled', 'archived')
     AND (NEW.status, NEW.customer_id, NEW.total_amount, NEW.total_paid, NEW.prepayment, NEW.discount_amount, NEW.sale_id)
         IS DISTINCT FROM
         (OLD.status, OLD.customer_id, OLD.total_amount, OLD.total_paid, OLD.prepayment, OLD.discount_amount, OLD.sale_id) THEN
    RAISE EXCEPTION 'ORDER_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$terminal_order_guard$;

DROP TRIGGER IF EXISTS trg_guard_terminal_order_mutation ON public.customer_orders;
CREATE TRIGGER trg_guard_terminal_order_mutation
BEFORE UPDATE ON public.customer_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_terminal_order_mutation();

CREATE OR REPLACE FUNCTION public.guard_supply_invoice_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $supply_delete_guard$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND (OLD.status <> 'draft' OR COALESCE(OLD.paid_amount, 0) <> 0) THEN
    RAISE EXCEPTION 'INVOICE_DELETE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$supply_delete_guard$;

DROP TRIGGER IF EXISTS trg_guard_supply_invoice_deletion ON public.supply_invoices;
CREATE TRIGGER trg_guard_supply_invoice_deletion
BEFORE UPDATE OF deleted_at ON public.supply_invoices
FOR EACH ROW EXECUTE FUNCTION public.guard_supply_invoice_deletion();

-- Remove historical empty test documents. They changed no stock and have no financial value.
DELETE FROM public.inventory_sessions s
WHERE s.status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM public.inventory_count_entries e WHERE e.session_id = s.id);
DELETE FROM public.inventory_writeoffs w
WHERE NOT EXISTS (SELECT 1 FROM public.inventory_writeoff_items i WHERE i.writeoff_id = w.id);

-- Old builds could mark an order completed without creating a receipt. Preserve its
ALTER TABLE public.customer_orders DISABLE TRIGGER trg_guard_terminal_order_mutation;
--
-- rows and payments, but quarantine it from normal completed-order workflows.
UPDATE public.customer_orders
SET status = 'archived',
    comment = CONCAT_WS(E'\n', NULLIF(comment, ''), 'Автоматично архівовано: стара версія завершила заказ без чека.'),
    updated_at = NOW()
WHERE status = 'completed' AND sale_id IS NULL;
ALTER TABLE public.customer_orders ENABLE TRIGGER trg_guard_terminal_order_mutation;
UPDATE public.inventory_reserves r
SET released_at = COALESCE(released_at, NOW())
WHERE released_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.customer_orders o
    WHERE o.id = r.order_id AND o.tenant_id = r.tenant_id AND o.status = 'archived'
  );

-- Business mutations are server-only. PostgreSQL grants EXECUTE to PUBLIC by default,
-- so revoke every overload explicitly and keep only service_role.
DO $rpc_privileges$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[
        'cancel_supply_invoice', 'complete_customer_order', 'complete_inventory_session',
        'post_supply_invoice', 'process_writeoff', 'reserve_order_items',
        'start_inventory_session', 'update_customer_order_status',
        'process_return_v2', 'process_return_v3'
      ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.signature);
  END LOOP;
END;
$rpc_privileges$;

REVOKE ALL ON FUNCTION public.guard_terminal_order_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_supply_invoice_deletion() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';