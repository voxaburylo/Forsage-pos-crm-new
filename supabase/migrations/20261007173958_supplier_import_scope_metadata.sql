-- NULL mode means legacy scope is unknown: never invent add/replace history.
ALTER TABLE public.supplier_price_imports
  ADD COLUMN mode text CHECK (mode IN ('add', 'replace')),
  ADD COLUMN warehouse_name text;

COMMENT ON COLUMN public.supplier_price_imports.mode IS
  'Original local import mode; NULL for legacy copies without scope evidence.';
COMMENT ON COLUMN public.supplier_price_imports.warehouse_name IS
  'Original local import warehouse; NULL is unassigned only when mode is known.';
