-- Stage 2: financial integrity, cash returns, sale replay safety and least privilege.

ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS request_hash TEXT;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS client_operation_id TEXT,
  ADD COLUMN IF NOT EXISTS client_payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS fiscal_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS fiscal_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tenant_client_operation
  ON public.sales(tenant_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

UPDATE public.sales
SET cash_amount = total
WHERE status IN ('completed', 'returned')
  AND payment_method = 'cash'
  AND COALESCE(cash_amount, 0) = 0
  AND COALESCE(card_amount, 0) = 0
  AND COALESCE(transfer_amount, 0) = 0;

UPDATE public.sales
SET card_amount = total
WHERE status IN ('completed', 'returned')
  AND payment_method = 'card'
  AND COALESCE(cash_amount, 0) = 0
  AND COALESCE(card_amount, 0) = 0
  AND COALESCE(transfer_amount, 0) = 0;

UPDATE public.sales
SET transfer_amount = total
WHERE status IN ('completed', 'returned')
  AND payment_method = 'transfer'
  AND COALESCE(cash_amount, 0) = 0
  AND COALESCE(card_amount, 0) = 0
  AND COALESCE(transfer_amount, 0) = 0;

UPDATE public.sales
SET fiscal_status = CASE
  WHEN is_fiscal = TRUE AND fiscal_number IS NOT NULL THEN 'completed'
  WHEN is_fiscal = TRUE THEN 'failed'
  ELSE 'not_requested'
END
WHERE fiscal_status = 'not_requested';

ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_fiscal_status_check;
ALTER TABLE public.sales ADD CONSTRAINT sales_fiscal_status_check
  CHECK (fiscal_status IN ('not_requested', 'pending', 'completed', 'failed'));

ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_payment_amounts_nonnegative;
ALTER TABLE public.sales ADD CONSTRAINT sales_payment_amounts_nonnegative
  CHECK (
    subtotal >= 0 AND discount >= 0 AND total >= 0
    AND COALESCE(cash_amount, 0) >= 0
    AND COALESCE(card_amount, 0) >= 0
    AND COALESCE(transfer_amount, 0) >= 0
  );

ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_payment_amounts_match;
ALTER TABLE public.sales ADD CONSTRAINT sales_payment_amounts_match
  CHECK (
    status NOT IN ('completed', 'returned')
    OR (payment_method = 'cash'
        AND cash_amount = total AND card_amount = 0 AND COALESCE(transfer_amount, 0) = 0)
    OR (payment_method = 'card'
        AND card_amount = total AND cash_amount = 0 AND COALESCE(transfer_amount, 0) = 0)
    OR (payment_method = 'transfer'
        AND COALESCE(transfer_amount, 0) = total AND cash_amount = 0 AND card_amount = 0)
    OR (payment_method = 'mixed'
        AND cash_amount + card_amount = total AND COALESCE(transfer_amount, 0) = 0)
    OR (payment_method = 'debt'
        AND cash_amount = 0 AND card_amount = 0 AND COALESCE(transfer_amount, 0) = 0)
  ) NOT VALID;

ALTER TABLE public.sales VALIDATE CONSTRAINT sales_payment_amounts_match;

CREATE OR REPLACE FUNCTION public.process_return_v3(
    p_tenant_id         UUID,
    p_user_id           UUID,
    p_sale_id           UUID,
    p_reason            VARCHAR(50),
    p_refund_method     VARCHAR(20),
    p_items             JSONB,
    p_operation_id      UUID,
    p_shift_id          UUID,
    p_customer_id       UUID DEFAULT NULL,
    p_reason_note       TEXT DEFAULT NULL,
    p_stock_action      VARCHAR(20) DEFAULT 'return_to_stock',
    p_fiscal_number     VARCHAR(128) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $return_v3$
DECLARE
    v_result JSONB;
    v_return_id UUID;
    v_refund INTEGER;
    v_existing public.cash_operations%ROWTYPE;
    v_available_cash BIGINT;
BEGIN
    IF p_refund_method = 'cash' THEN
        IF p_shift_id IS NULL THEN
            RAISE EXCEPTION 'OPEN_SHIFT_REQUIRED';
        END IF;

        PERFORM 1
        FROM public.shifts s
        WHERE s.id = p_shift_id
          AND s.tenant_id = p_tenant_id
          AND s.status = 'open'
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'OPEN_SHIFT_REQUIRED';
        END IF;
    END IF;

    v_result := public.process_return_v2(
        p_tenant_id => p_tenant_id,
        p_user_id => p_user_id,
        p_sale_id => p_sale_id,
        p_reason => p_reason,
        p_refund_method => p_refund_method,
        p_items => p_items,
        p_operation_id => p_operation_id,
        p_customer_id => p_customer_id,
        p_reason_note => p_reason_note,
        p_stock_action => p_stock_action,
        p_fiscal_number => p_fiscal_number
    );

    IF p_refund_method = 'cash' THEN
        v_return_id := (v_result->>'id')::UUID;
        v_refund := COALESCE((v_result->>'refund_kopecks')::INTEGER, 0);
        IF v_return_id IS NULL OR v_refund <= 0 THEN
            RAISE EXCEPTION 'RETURN_RESULT_MISSING';
        END IF;

        SELECT GREATEST(0,
          COALESCE(s.opening_cash, 0)
          + COALESCE((
              SELECT SUM(CASE
                WHEN sale.payment_method = 'cash' THEN COALESCE(NULLIF(sale.cash_amount, 0), sale.total)
                ELSE COALESCE(sale.cash_amount, 0)
              END)
              FROM public.sales sale
              WHERE sale.tenant_id = p_tenant_id
                AND sale.shift_id = p_shift_id
                AND sale.status = 'completed'
                AND NOT EXISTS (
                  SELECT 1 FROM public.customer_orders order_row
                  WHERE order_row.tenant_id = p_tenant_id AND order_row.sale_id = sale.id
                )
            ), 0)
          + COALESCE((
              SELECT SUM(CASE WHEN operation.type = 'in' THEN operation.amount ELSE -operation.amount END)
              FROM public.cash_operations operation
              WHERE operation.tenant_id = p_tenant_id AND operation.shift_id = p_shift_id
            ), 0)
        ) INTO v_available_cash
        FROM public.shifts s
        WHERE s.id = p_shift_id AND s.tenant_id = p_tenant_id;

        IF v_available_cash < v_refund THEN
          RAISE EXCEPTION 'CASHBOX_INSUFFICIENT_FUNDS:%', v_available_cash;
        END IF;

        INSERT INTO public.cash_operations (
          id, tenant_id, shift_id, type, amount, note, source, created_by, created_at
        ) VALUES (
          v_return_id, p_tenant_id, p_shift_id, 'out', v_refund,
          'Повернення за чеком', 'cashbox', p_user_id, NOW()
        )
        ON CONFLICT (id) DO NOTHING;

        SELECT * INTO v_existing
        FROM public.cash_operations
        WHERE id = v_return_id;
        IF v_existing.tenant_id IS DISTINCT FROM p_tenant_id
           OR v_existing.shift_id IS DISTINCT FROM p_shift_id
           OR v_existing.type IS DISTINCT FROM 'out'
           OR v_existing.amount IS DISTINCT FROM v_refund THEN
            RAISE EXCEPTION 'RETURN_CASH_OPERATION_CONFLICT';
        END IF;
    END IF;

    RETURN v_result;
END;
$return_v3$;

REVOKE ALL ON FUNCTION public.process_return_v3(
  UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, UUID, UUID, TEXT, VARCHAR, VARCHAR
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_return_v3(
  UUID, UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, UUID, UUID, TEXT, VARCHAR, VARCHAR
) TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_paid_invoice_cancellation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $paid_invoice_guard$
BEGIN
  IF NEW.status = 'cancelled'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND COALESCE(OLD.paid_amount, 0) > 0 THEN
    RAISE EXCEPTION 'PAID_INVOICE_CANNOT_BE_CANCELLED';
  END IF;
  RETURN NEW;
END;
$paid_invoice_guard$;

DROP TRIGGER IF EXISTS trg_prevent_paid_invoice_cancellation ON public.supply_invoices;
CREATE TRIGGER trg_prevent_paid_invoice_cancellation
BEFORE UPDATE OF status ON public.supply_invoices
FOR EACH ROW EXECUTE FUNCTION public.prevent_paid_invoice_cancellation();

-- Financial ledgers are read-only to browser JWTs. All writes go through the
-- application server (service_role) so validation and audit cannot be bypassed.
DO $financial_rls$
DECLARE
  table_name TEXT;
  policy_row RECORD;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sales', 'sale_items', 'returns', 'return_items', 'order_payments',
    'supplier_payments', 'supply_invoices', 'cash_operations', 'customers',
    'customer_deposit_transactions', 'bonus_transactions',
    'payment_reconciliation', 'idempotency_keys'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    FOR policy_row IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = table_name
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_row.policyname, table_name);
    END LOOP;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
    EXECUTE format(
      'CREATE POLICY financial_tenant_select ON public.%I FOR SELECT TO authenticated USING (tenant_id = (SELECT app.user_tenant_id()))',
      table_name
    );
  END LOOP;
END;
$financial_rls$;

UPDATE public.shop_settings
SET allow_negative_qty = FALSE, updated_at = NOW()
WHERE allow_negative_qty IS DISTINCT FROM FALSE;

NOTIFY pgrst, 'reload schema';