-- Preserve the exact unpaid portion of a local receipt. NULL marks legacy
-- writers; no historical amounts, stock, payments or balances are rewritten.
-- Deploy this migration before the sale-copy server change.
BEGIN;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS debt_amount INTEGER;
ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_debt_amount_nonnegative;
ALTER TABLE public.sales ADD CONSTRAINT sales_debt_amount_nonnegative
  CHECK (debt_amount IS NULL OR debt_amount >= 0) NOT VALID;
ALTER TABLE public.sales VALIDATE CONSTRAINT sales_debt_amount_nonnegative;

-- The old mixed rule accepted only cash + card. It rejected legitimate local
-- cash + transfer and cash + debt receipts, leaving the web copy incomplete.
ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_payment_amounts_match;
ALTER TABLE public.sales ADD CONSTRAINT sales_payment_amounts_match CHECK (
  status NOT IN ('completed','returned')
  OR (
    COALESCE(cash_amount,0) >= 0 AND COALESCE(card_amount,0) >= 0
    AND COALESCE(transfer_amount,0) >= 0 AND COALESCE(debt_amount,0) >= 0
    AND (
      (payment_method='cash' AND cash_amount=total AND card_amount=0
        AND COALESCE(transfer_amount,0)=0 AND COALESCE(debt_amount,0)=0)
      OR (payment_method='card' AND card_amount=total AND cash_amount=0
        AND COALESCE(transfer_amount,0)=0 AND COALESCE(debt_amount,0)=0)
      OR (payment_method='transfer' AND transfer_amount=total AND cash_amount=0
        AND card_amount=0 AND COALESCE(debt_amount,0)=0)
      OR (payment_method='debt' AND cash_amount=0 AND card_amount=0
        AND COALESCE(transfer_amount,0)=0 AND COALESCE(debt_amount,total)=total)
      OR (payment_method='mixed'
        AND cash_amount::bigint + card_amount::bigint + COALESCE(transfer_amount,0)::bigint
          + COALESCE(debt_amount::bigint, CASE WHEN is_debt THEN
              GREATEST(total::bigint-cash_amount::bigint-card_amount::bigint-COALESCE(transfer_amount,0)::bigint,0)
              ELSE 0 END) = total::bigint
        AND (COALESCE(debt_amount,0)=0 OR is_debt))
    )
  )
) NOT VALID;
-- Validate, don't repair, existing receipts. A failed preflight rolls back the
-- whole migration and calls for reconciliation rather than inventing payments.
ALTER TABLE public.sales VALIDATE CONSTRAINT sales_payment_amounts_match;
COMMIT;
