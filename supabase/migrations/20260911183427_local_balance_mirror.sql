-- Owner-registered local database is authoritative. No public API grants.
BEGIN;
CREATE TABLE public.local_mirror_authorities (
  tenant_id uuid PRIMARY KEY,
  device_id text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.local_balance_mirror (
  tenant_id uuid NOT NULL REFERENCES public.local_mirror_authorities(tenant_id),
  entity_type text NOT NULL CHECK (entity_type IN ('product','customer')),
  entity_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version >= 0),
  balances jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);
ALTER TABLE public.local_mirror_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.local_balance_mirror ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.local_mirror_authorities, public.local_balance_mirror FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.enforce_local_balance_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE snapshot jsonb;
BEGIN
  SELECT balances INTO snapshot FROM public.local_balance_mirror
  WHERE tenant_id = NEW.tenant_id AND entity_id = NEW.id
    AND entity_type = CASE WHEN TG_TABLE_NAME = 'products' THEN 'product' ELSE 'customer' END
  FOR SHARE;
  IF FOUND THEN
    IF TG_TABLE_NAME = 'products' THEN
      NEW.qty_on_hand := (snapshot->>'qty_on_hand')::numeric;
    ELSE
      NEW.debt_balance := (snapshot->>'debt_balance')::bigint;
      NEW.deposit_balance := (snapshot->>'deposit_balance')::bigint;
      NEW.bonus_balance := (snapshot->>'bonus_balance')::bigint;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_local_balance_mirror() FROM PUBLIC, anon, authenticated;
-- Alphabetical ordering ensures canonical values reach existing validation triggers.
CREATE TRIGGER aa_local_balance_mirror BEFORE INSERT OR UPDATE OF qty_on_hand ON public.products
FOR EACH ROW EXECUTE FUNCTION public.enforce_local_balance_mirror();
CREATE TRIGGER aa_local_balance_mirror BEFORE INSERT OR UPDATE OF debt_balance, deposit_balance, bonus_balance ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.enforce_local_balance_mirror();
COMMIT;
