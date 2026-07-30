-- A legacy invoice could retain a product_id after that product had already
-- been soft-deleted. Posting then received stock into a hidden card, and the
-- stock-integrity reconciliation correctly zeroed the deleted product.
--
-- Restore only products that were already deleted before a currently posted
-- supply invoice referenced them. Products deleted after their historical
-- receipt remain deleted.
DO $$
DECLARE
  v_row RECORD;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  PERFORM set_config('app.stock_source_type', 'supply_deleted_product_recovery', TRUE);
  FOR v_row IN
    SELECT
      p.id AS product_id,
      p.tenant_id,
      COALESCE(SUM(ii.qty), 0)::NUMERIC(12,3) AS received_qty,
      COALESCE(MAX(ii.purchase_price), p.purchase_price, 0)::INTEGER AS unit_cost
    FROM public.products p
    JOIN public.supply_invoice_items ii
      ON ii.product_id = p.id
     AND ii.tenant_id = p.tenant_id
     AND ii.created_at > p.deleted_at
    JOIN public.supply_invoices si
      ON si.id = ii.invoice_id
     AND si.tenant_id = p.tenant_id
     AND si.status = 'posted'
     AND si.deleted_at IS NULL
    WHERE p.deleted_at IS NOT NULL
    GROUP BY p.id, p.tenant_id
  LOOP
    UPDATE public.products
    SET deleted_at = NULL,
        is_active = TRUE,
        qty_on_hand = qty_on_hand + v_row.received_qty,
        purchase_price = v_row.unit_cost,
        updated_at = v_now
    WHERE id = v_row.product_id
      AND tenant_id = v_row.tenant_id
      AND deleted_at IS NOT NULL
    ;
  END LOOP;
  PERFORM set_config('app.stock_source_type', '', TRUE);
END;
$$;
