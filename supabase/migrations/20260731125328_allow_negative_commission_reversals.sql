-- Commission reversals are compensating salary ledger entries and therefore
-- must be negative. Every other salary payment remains strictly positive.

ALTER TABLE public.salary_payments
  DROP CONSTRAINT IF EXISTS salary_payments_amount_check;

ALTER TABLE public.salary_payments
  ADD CONSTRAINT salary_payments_amount_check
  CHECK (
    (source = 'commission_reversal' AND amount < 0)
    OR (source <> 'commission_reversal' AND amount > 0)
  );

NOTIFY pgrst, 'reload schema';
