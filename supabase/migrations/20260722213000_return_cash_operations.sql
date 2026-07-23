-- Cash refunds are movements of the shift where the refund happened.
-- They must never be inferred from the shift of the original sale.

CREATE OR REPLACE FUNCTION record_return_cash_operation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shift_id UUID;
  v_amount INTEGER;
  v_existing_tenant UUID;
  v_existing_type VARCHAR(10);
  v_existing_amount INTEGER;
  v_existing_source VARCHAR(30);
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'completed'
     AND (NEW.status, NEW.refund_method, NEW.refund_kopecks, NEW.refund_amount)
         IS DISTINCT FROM
         (OLD.status, OLD.refund_method, OLD.refund_kopecks, OLD.refund_amount) THEN
    RAISE EXCEPTION 'RETURN_FINANCIAL_FIELDS_IMMUTABLE: Фінансові дані завершеного повернення не можна змінювати';
  END IF;

  IF NEW.status <> 'completed' OR NEW.refund_method <> 'cash' THEN
    RETURN NEW;
  END IF;

  v_amount := COALESCE(NEW.refund_kopecks, NEW.refund_amount, 0);
  IF v_amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Offline sync supplies the original local shift explicitly and writes the
  -- deterministic operation itself. Skipping the trigger prevents attributing
  -- that historical refund to whichever server shift happens to be open now.
  IF current_setting('app.sync_mode', true) = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT co.tenant_id, co.type, co.amount, co.source
    INTO v_existing_tenant, v_existing_type, v_existing_amount, v_existing_source
    FROM cash_operations co
   WHERE co.id = NEW.id;

  IF FOUND THEN
    IF v_existing_tenant IS DISTINCT FROM NEW.tenant_id
       OR v_existing_type IS DISTINCT FROM 'out'
       OR v_existing_amount IS DISTINCT FROM v_amount
       OR v_existing_source IS DISTINCT FROM 'cashbox' THEN
      RAISE EXCEPTION 'RETURN_CASH_OPERATION_CONFLICT: Касова операція повернення не збігається з поверненням';
    END IF;
    RETURN NEW;
  END IF;

  SELECT s.id
    INTO v_shift_id
    FROM shifts s
   WHERE s.tenant_id = NEW.tenant_id
     AND s.cashier_id = COALESCE(NEW.approved_by, NEW.created_by)
     AND s.status = 'open'
   ORDER BY s.opened_at DESC
   LIMIT 1;

  IF v_shift_id IS NULL THEN
    RAISE EXCEPTION 'OPEN_SHIFT_REQUIRED: Спочатку відкрийте касову зміну';
  END IF;

  INSERT INTO cash_operations (
    id, tenant_id, shift_id, type, amount, note, source, created_by, created_at
  ) VALUES (
    NEW.id,
    NEW.tenant_id,
    v_shift_id,
    'out',
    v_amount,
    'Повернення за чеком',
    'cashbox',
    COALESCE(NEW.approved_by, NEW.created_by),
    COALESCE(NEW.created_at, NOW())
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_return_cash_operation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_return_cash_operation()
  TO service_role;

DROP TRIGGER IF EXISTS trg_return_cash_operation ON returns;
CREATE TRIGGER trg_return_cash_operation
AFTER INSERT OR UPDATE OF status, refund_method, refund_kopecks, refund_amount
ON returns
FOR EACH ROW
EXECUTE FUNCTION record_return_cash_operation();

-- Історичні повернення навмисно не прив'язуємо евристично до чужої зміни.
-- Неоднозначні старі операції мають пройти ручну касову звірку.

NOTIFY pgrst, 'reload schema';
