BEGIN;

-- Keep the public schema behind the application API.
-- The browser does not query business tables directly; every operation goes
-- through the Express API where tenant and staff-role checks are enforced.

-- Production drift left this internal queue without RLS even though an older
-- migration was recorded as applied. Repair the live state explicitly.
ALTER TABLE public.sys_background_jobs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  policy_row RECORD;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sys_background_jobs'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.sys_background_jobs',
      policy_row.policyname
    );
  END LOOP;
END;
$$;

-- Keep extension objects out of the application schema. Existing trigram indexes
-- retain their operator-class OIDs when the extension is relocated.
CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;

-- Pin function lookup so a writable or temporary schema cannot shadow objects
-- used by privileged business functions. Extension-owned functions are managed
-- by PostgreSQL and are intentionally excluded.
DO $$
DECLARE
  function_row RECORD;
BEGIN
  FOR function_row IN
    SELECT
      namespace.nspname AS schema_name,
      procedure.proname AS function_name,
      pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname IN ('public', 'app')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = procedure.oid
          AND dependency.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, public, app, extensions, pg_temp',
      function_row.schema_name,
      function_row.function_name,
      function_row.identity_arguments
    );
  END LOOP;
END;
$$;
-- Data API access is unnecessary for this application and made UI role checks
-- bypassable. Service-role server processes retain full access.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Authorization helpers remain available only for authenticated RLS checks.
REVOKE ALL ON FUNCTION app.user_tenant_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.has_role(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.user_tenant_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.has_role(TEXT[]) TO authenticated, service_role;

-- New objects must not silently become public Data API endpoints.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- The PIN table has no tenant_id column. If direct access is ever deliberately
-- restored, owner/admin access must still be constrained to their own tenant.
CREATE OR REPLACE FUNCTION app.user_belongs_to_current_tenant(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM auth.users AS target_user
      WHERE target_user.id = target_user_id
        AND target_user.raw_app_meta_data ->> 'tenant_id'
          = (SELECT app.user_tenant_id())::TEXT
    );
$$;

REVOKE ALL ON FUNCTION app.user_belongs_to_current_tenant(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.user_belongs_to_current_tenant(UUID)
  TO authenticated, service_role;

ALTER TABLE public.staff_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_pins_select ON public.staff_pins;
DROP POLICY IF EXISTS staff_pins_insert ON public.staff_pins;
DROP POLICY IF EXISTS staff_pins_update ON public.staff_pins;
DROP POLICY IF EXISTS staff_pins_delete ON public.staff_pins;

CREATE POLICY staff_pins_select
  ON public.staff_pins
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      (SELECT app.has_role(ARRAY['owner', 'admin']))
      AND (SELECT app.user_belongs_to_current_tenant(user_id))
    )
  );

CREATE POLICY staff_pins_insert
  ON public.staff_pins
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR (
      (SELECT app.has_role(ARRAY['owner', 'admin']))
      AND (SELECT app.user_belongs_to_current_tenant(user_id))
    )
  );

CREATE POLICY staff_pins_update
  ON public.staff_pins
  FOR UPDATE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      (SELECT app.has_role(ARRAY['owner', 'admin']))
      AND (SELECT app.user_belongs_to_current_tenant(user_id))
    )
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR (
      (SELECT app.has_role(ARRAY['owner', 'admin']))
      AND (SELECT app.user_belongs_to_current_tenant(user_id))
    )
  );

CREATE POLICY staff_pins_delete
  ON public.staff_pins
  FOR DELETE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      (SELECT app.has_role(ARRAY['owner', 'admin']))
      AND (SELECT app.user_belongs_to_current_tenant(user_id))
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
