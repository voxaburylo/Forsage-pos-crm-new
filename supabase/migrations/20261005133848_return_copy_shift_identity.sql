-- Keep the exact local return shift (including an explicit absence of a shift).
-- Old NULLs remain unknown: no historical financial row is inferred or rewritten.
-- Apply before deploying the new return-copy writer.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.returns
  ADD COLUMN IF NOT EXISTS shift_id uuid,
  ADD COLUMN IF NOT EXISTS shift_link_recorded boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_tenant_id
  ON public.shifts(tenant_id,id);
CREATE INDEX IF NOT EXISTS idx_returns_tenant_shift
  ON public.returns(tenant_id,shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE public.returns DROP CONSTRAINT IF EXISTS returns_shift_link_recorded;
ALTER TABLE public.returns ADD CONSTRAINT returns_shift_link_recorded
  CHECK (shift_id IS NULL OR shift_link_recorded) NOT VALID;
ALTER TABLE public.returns VALIDATE CONSTRAINT returns_shift_link_recorded;

ALTER TABLE public.returns DROP CONSTRAINT IF EXISTS returns_shift_same_tenant;
ALTER TABLE public.returns ADD CONSTRAINT returns_shift_same_tenant
  FOREIGN KEY (tenant_id,shift_id) REFERENCES public.shifts(tenant_id,id)
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.returns VALIDATE CONSTRAINT returns_shift_same_tenant;

CREATE OR REPLACE FUNCTION public.guard_return_shift_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='completed'
    AND (NEW.tenant_id,NEW.shift_id,NEW.shift_link_recorded)
      IS DISTINCT FROM (OLD.tenant_id,OLD.shift_id,OLD.shift_link_recorded) THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR OLD.shift_link_recorded
      OR NOT NEW.shift_link_recorded
      OR current_setting('app.sync_mode',true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'RETURN_SHIFT_IMMUTABLE: Recorded return shift cannot be replaced';
    END IF;
    -- Only the trusted copy writer may enrich a previously unknown link after
    -- comparing the complete immutable header, lines and money movement.
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_return_shift_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_return_shift_identity() TO service_role;
DROP TRIGGER IF EXISTS trg_return_shift_identity ON public.returns;
CREATE TRIGGER trg_return_shift_identity
  BEFORE UPDATE OF tenant_id,shift_id,shift_link_recorded ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.guard_return_shift_identity();

NOTIFY pgrst, 'reload schema';
COMMIT;
