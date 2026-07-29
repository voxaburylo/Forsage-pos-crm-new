-- Stage 4: customer money, loyalty, salary and return-commission integrity.

-- Never hide a customer while money is still attached to the account.
UPDATE public.customers
SET deleted_at = NULL, updated_at = NOW()
WHERE deleted_at IS NOT NULL
  AND (
    COALESCE(debt_balance, 0) <> 0
    OR COALESCE(deposit_balance, 0) <> 0
    OR COALESCE(bonus_balance, 0) <> 0
  );

CREATE OR REPLACE FUNCTION public.guard_customer_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $customer_delete_guard$
DECLARE
  customer_row public.customers%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    customer_row := OLD;
  ELSE
    customer_row := NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NOT (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
    RETURN NEW;
  END IF;

  IF COALESCE(customer_row.debt_balance, 0) <> 0
     OR COALESCE(customer_row.deposit_balance, 0) <> 0
     OR COALESCE(customer_row.bonus_balance, 0) <> 0 THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_BALANCE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_orders customer_order
    WHERE customer_order.customer_id = customer_row.id
      AND customer_order.tenant_id = customer_row.tenant_id
      AND customer_order.deleted_at IS NULL
      AND customer_order.status NOT IN ('completed', 'cancelled', 'canceled', 'archived')
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_ACTIVE_ORDERS';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$customer_delete_guard$;

DROP TRIGGER IF EXISTS trg_guard_customer_soft_delete ON public.customers;
CREATE TRIGGER trg_guard_customer_soft_delete
BEFORE UPDATE OF deleted_at ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_deletion();

DROP TRIGGER IF EXISTS trg_guard_customer_hard_delete ON public.customers;
CREATE TRIGGER trg_guard_customer_hard_delete
BEFORE DELETE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_deletion();

-- One cashback/bonus movement per sale prevents duplicate retries.
ALTER TABLE public.bonus_transactions
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bonus_transaction_sale_type
  ON public.bonus_transactions(tenant_id, source_sale_id, transaction_type)
  WHERE source_sale_id IS NOT NULL AND transaction_type IN ('earn', 'spend');

CREATE INDEX IF NOT EXISTS idx_bonus_transactions_expiry
  ON public.bonus_transactions(tenant_id, customer_id, expires_at)
  WHERE transaction_type = 'earn' AND expires_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_deposit_cashback_sale
  ON public.customer_deposit_transactions(tenant_id, sale_id)
  WHERE sale_id IS NOT NULL AND method = 'cashback';

-- A return reversal is uniquely tied to the return and employee.
ALTER TABLE public.salary_payments
  ADD COLUMN IF NOT EXISTS commission_source_return_id UUID REFERENCES public.returns(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_return_commission
  ON public.salary_payments(tenant_id, employee_id, commission_source_return_id)
  WHERE commission_source_return_id IS NOT NULL
    AND source = 'commission_reversal';

-- Financial mutation RPCs are server-only. Browser JWTs remain read-only.
REVOKE ALL ON FUNCTION public.customer_deposit_change(UUID, UUID, INTEGER, TEXT, UUID, UUID, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_deposit_change(UUID, UUID, INTEGER, TEXT, UUID, UUID, UUID, TEXT, UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.process_bonus_earn(UUID, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_bonus_earn(UUID, INTEGER, UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.process_bonus_spend(UUID, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_bonus_spend(UUID, INTEGER, UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';
