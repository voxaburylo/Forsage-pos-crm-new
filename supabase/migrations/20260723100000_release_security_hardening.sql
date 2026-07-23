-- Final release hardening: trusted auth claims, complete tenant RLS and
-- security-invoker catalog views. This migration is intentionally last.

CREATE SCHEMA IF NOT EXISTS app;

-- Existing users were created before authorization fields moved to
-- raw_app_meta_data. Copy them once, preserving Supabase provider metadata.
-- A missing tenant is first recovered from that cashier's latest shift. The
-- single-tenant fallback is used only when all core data agrees on one tenant.
WITH known_tenants AS (
  SELECT tenant_id FROM public.products WHERE tenant_id IS NOT NULL
  UNION
  SELECT tenant_id FROM public.customers WHERE tenant_id IS NOT NULL
  UNION
  SELECT tenant_id FROM public.shifts WHERE tenant_id IS NOT NULL
  UNION
  SELECT tenant_id FROM public.sales WHERE tenant_id IS NOT NULL
),
single_tenant AS (
  SELECT MIN(tenant_id::text) AS tenant_id
  FROM known_tenants
  HAVING COUNT(*) = 1
)
UPDATE auth.users AS user_row
SET raw_app_meta_data = COALESCE(user_row.raw_app_meta_data, '{}'::jsonb)
  || jsonb_strip_nulls(jsonb_build_object(
    'tenant_id', COALESCE(
      user_row.raw_app_meta_data ->> 'tenant_id',
      user_row.raw_user_meta_data ->> 'tenant_id',
      (
        SELECT shift_row.tenant_id::text
        FROM public.shifts shift_row
        WHERE shift_row.cashier_id = user_row.id
        ORDER BY shift_row.opened_at DESC, shift_row.id DESC
        LIMIT 1
      ),
      (SELECT tenant_id FROM single_tenant)
    ),
    'role', COALESCE(
      user_row.raw_app_meta_data ->> 'role',
      user_row.raw_user_meta_data ->> 'role',
      'cashier'
    ),
    'is_active', COALESCE(
      user_row.raw_app_meta_data -> 'is_active',
      user_row.raw_user_meta_data -> 'is_active',
      'true'::jsonb
    ),
    'base_rate', COALESCE(
      user_row.raw_app_meta_data -> 'base_rate',
      user_row.raw_user_meta_data -> 'base_rate',
      '0'::jsonb
    ),
    'rate_period', COALESCE(
      user_row.raw_app_meta_data ->> 'rate_period',
      user_row.raw_user_meta_data ->> 'rate_period',
      'month'
    )
  ));

CREATE OR REPLACE FUNCTION app.user_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN COALESCE(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
    ELSE NULL::UUID
  END;
$$;

CREATE OR REPLACE FUNCTION app.has_role(required_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'app_metadata' ->> 'role') = ANY(required_roles),
    false
  );
$$;

GRANT USAGE ON SCHEMA app TO authenticated;
REVOKE ALL ON FUNCTION app.user_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.has_role(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION app.has_role(TEXT[]) TO authenticated;

-- Repair a production drift where migration 119 was recorded but its table is
-- absent. The statement is idempotent for correctly migrated databases.
CREATE TABLE IF NOT EXISTS public.payment_reconciliation (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  payment_ref    TEXT,
  sale_id        UUID,
  amount_kopecks BIGINT NOT NULL DEFAULT 0,
  rrn            TEXT,
  auth_code      TEXT,
  pan_masked     TEXT,
  status         TEXT NOT NULL,
  reason         TEXT,
  resolved       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_unresolved
  ON public.payment_reconciliation (tenant_id, resolved, created_at);

-- Remove every remaining unconditional policy and replace it with one
-- explicit same-tenant policy. Production had older policies still present,
-- so every policy on an affected table is replaced, not only the `true` one.
DO $$
DECLARE
  v_table TEXT;
  v_policy RECORD;
BEGIN
  FOR v_table IN
    SELECT DISTINCT p.tablename
    FROM pg_policies p
    JOIN information_schema.columns c
      ON c.table_schema = p.schemaname
     AND c.table_name = p.tablename
     AND c.column_name = 'tenant_id'
    WHERE p.schemaname = 'public'
      AND (
        regexp_replace(COALESCE(p.qual, ''), '[()[:space:]]', '', 'g') = 'true'
        OR regexp_replace(COALESCE(p.with_check, ''), '[()[:space:]]', '', 'g') = 'true'
      )
    UNION
    SELECT unnest(ARRAY['payment_reconciliation', 'customer_deposit_transactions'])
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    FOR v_policy IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy.policyname, v_table);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY release_tenant_all ON public.%I FOR ALL TO authenticated '
      || 'USING (tenant_id = (SELECT app.user_tenant_id())) '
      || 'WITH CHECK (tenant_id = (SELECT app.user_tenant_id()))',
      v_table
    );
  END LOOP;
END;
$$;

-- Child tables do not carry tenant_id. Replace every older permissive policy
-- and enforce ownership through the direct parent row instead. Where a child
-- links another tenant-owned entity, that link must belong to the same tenant.
DO $$
DECLARE
  v_relation RECORD;
  v_policy RECORD;
  v_condition TEXT;
BEGIN
  FOR v_relation IN
    SELECT *
    FROM (VALUES
      ('customer_group_members',     'group_id',    'customer_groups'),
      ('customer_order_items',       'order_id',    'customer_orders'),
      ('inventory_items',            'session_id',  'inventory_sessions'),
      ('inventory_writeoff_items',   'writeoff_id', 'inventory_writeoffs'),
      ('messenger_messages',         'chat_id',     'messenger_chats'),
      ('order_activity_log',         'order_id',    'customer_orders'),
      ('product_photos',             'product_id',  'products')
    ) AS relations(child_table, parent_column, parent_table)
  LOOP
    IF to_regclass(format('public.%I', v_relation.child_table)) IS NULL
       OR to_regclass(format('public.%I', v_relation.parent_table)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_relation.child_table
    );

    FOR v_policy IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_relation.child_table
    LOOP
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        v_policy.policyname,
        v_relation.child_table
      );
    END LOOP;

    v_condition := format(
      'EXISTS ('
      || 'SELECT 1 FROM public.%1$I parent_row '
      || 'WHERE parent_row.id = %2$I.%3$I '
      || 'AND parent_row.tenant_id = (SELECT app.user_tenant_id())'
      || ')',
      v_relation.parent_table,
      v_relation.child_table,
      v_relation.parent_column
    );

    CASE v_relation.child_table
      WHEN 'customer_group_members' THEN
        v_condition := v_condition || format(
          ' AND EXISTS ('
          || 'SELECT 1 FROM public.customers linked_customer '
          || 'WHERE linked_customer.id = %1$I.customer_id '
          || 'AND linked_customer.tenant_id = (SELECT app.user_tenant_id())'
          || ')',
          v_relation.child_table
        );
      WHEN 'customer_order_items' THEN
        v_condition := v_condition || format(
          ' AND (%1$I.product_id IS NULL OR EXISTS ('
          || 'SELECT 1 FROM public.products linked_product '
          || 'WHERE linked_product.id = %1$I.product_id '
          || 'AND linked_product.tenant_id = (SELECT app.user_tenant_id())'
          || '))'
          || ' AND (%1$I.supplier_id IS NULL OR EXISTS ('
          || 'SELECT 1 FROM public.suppliers linked_supplier '
          || 'WHERE linked_supplier.id = %1$I.supplier_id '
          || 'AND linked_supplier.tenant_id = (SELECT app.user_tenant_id())'
          || '))',
          v_relation.child_table
        );
      WHEN 'inventory_items', 'inventory_writeoff_items' THEN
        v_condition := v_condition || format(
          ' AND EXISTS ('
          || 'SELECT 1 FROM public.products linked_product '
          || 'WHERE linked_product.id = %1$I.product_id '
          || 'AND linked_product.tenant_id = (SELECT app.user_tenant_id())'
          || ')',
          v_relation.child_table
        );
      ELSE
        NULL;
    END CASE;

    EXECUTE format(
      'CREATE POLICY release_parent_tenant_all ON public.%1$I '
      || 'FOR ALL TO authenticated '
      || 'USING (%2$s) '
      || 'WITH CHECK (%2$s)',
      v_relation.child_table,
      v_condition
    );
  END LOOP;
END;
$$;

-- A co-buy edge belongs to a tenant only when both linked products do.
DO $$
DECLARE
  v_policy RECORD;
BEGIN
  IF to_regclass('public.product_cobuy') IS NOT NULL
     AND to_regclass('public.products') IS NOT NULL THEN
    ALTER TABLE public.product_cobuy ENABLE ROW LEVEL SECURITY;

    FOR v_policy IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'product_cobuy'
    LOOP
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.product_cobuy',
        v_policy.policyname
      );
    END LOOP;

    CREATE POLICY release_product_cobuy_tenant
    ON public.product_cobuy
    FOR ALL
    TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.products source_product
        WHERE source_product.id = product_cobuy.product_id
          AND source_product.tenant_id = (SELECT app.user_tenant_id())
      )
      AND EXISTS (
        SELECT 1
        FROM public.products recommended_product
        WHERE recommended_product.id = product_cobuy.recommended_product_id
          AND recommended_product.tenant_id = (SELECT app.user_tenant_id())
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1
        FROM public.products source_product
        WHERE source_product.id = product_cobuy.product_id
          AND source_product.tenant_id = (SELECT app.user_tenant_id())
      )
      AND EXISTS (
        SELECT 1
        FROM public.products recommended_product
        WHERE recommended_product.id = product_cobuy.recommended_product_id
          AND recommended_product.tenant_id = (SELECT app.user_tenant_id())
      )
    );
  END IF;
END;
$$;

-- Views must execute with the caller's RLS context, not the view owner's.
ALTER VIEW public.products_available SET (security_invoker = true);
ALTER VIEW public.v_product_stock SET (security_invoker = true);

-- Persist transfer amounts for mixed/transfer sales and reports.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS transfer_amount INTEGER NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
