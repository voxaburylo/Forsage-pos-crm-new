BEGIN;

-- Internal, service-role-only state for the daily AI enrichment pass. A row is
-- retained after completion so the same product is not sent to Gemini again.
CREATE TABLE public.product_cross_enrichment_state (
  tenant_id          UUID NOT NULL,
  product_id         UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempt_count      SMALLINT NOT NULL DEFAULT 0,
  next_retry_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at          TIMESTAMPTZ,
  locked_by          TEXT,
  last_error         TEXT,
  result_count       INTEGER NOT NULL DEFAULT 0,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  CONSTRAINT product_cross_enrichment_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'no_match', 'failed')),
  CONSTRAINT product_cross_enrichment_attempts_check
    CHECK (attempt_count BETWEEN 0 AND 10),
  CONSTRAINT product_cross_enrichment_result_count_check
    CHECK (result_count >= 0)
);

CREATE INDEX product_cross_enrichment_retry_idx
  ON public.product_cross_enrichment_state (next_retry_at, updated_at)
  WHERE status IN ('pending', 'processing', 'failed');

ALTER TABLE public.product_cross_enrichment_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_cross_enrichment_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.product_cross_enrichment_state TO service_role;

-- Claim one tenant's small batch atomically. The advisory transaction lock also
-- prevents the two production Vercel projects from selecting the same rows.
CREATE OR REPLACE FUNCTION public.claim_product_cross_enrichment(
  p_worker_id TEXT,
  p_batch_size INTEGER DEFAULT 5
)
RETURNS TABLE (
  tenant_id UUID,
  product_id UUID,
  source_fingerprint TEXT,
  sku TEXT,
  name TEXT,
  oem_number TEXT,
  supplier_article TEXT,
  brand_name TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_batch_size INTEGER := LEAST(GREATEST(COALESCE(p_batch_size, 5), 1), 5);
BEGIN
  IF NULLIF(BTRIM(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'WORKER_ID_REQUIRED';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext('product_cross_enrichment_claim')) THEN
    RETURN;
  END IF;

  UPDATE public.product_cross_enrichment_state
  SET status = 'failed',
      next_retry_at = now(),
      locked_at = NULL,
      locked_by = NULL,
      last_error = 'Попередній фоновий запуск не завершився',
      updated_at = now()
  WHERE status = 'processing'
    AND locked_at < now() - INTERVAL '30 minutes';

  SELECT candidate.tenant_id
  INTO v_tenant_id
  FROM (
    SELECT p.tenant_id, MIN(COALESCE(state.updated_at, p.created_at)) AS oldest_at
    FROM public.products AS p
    JOIN public.shop_settings AS settings
      ON settings.tenant_id = p.tenant_id
     AND settings.ai_enabled = true
     AND NULLIF(settings.ai_api_key_encrypted, '') IS NOT NULL
    LEFT JOIN public.brands AS brand ON brand.id = p.brand_id
    LEFT JOIN public.product_cross_enrichment_state AS state
      ON state.tenant_id = p.tenant_id
     AND state.product_id = p.id
    WHERE p.deleted_at IS NULL
      AND p.is_active = true
      AND COALESCE(p.is_service, false) = false
      AND p.sku NOT ILIKE 'POS-%'
      AND (
        state.product_id IS NULL
        OR state.source_fingerprint <> md5(concat_ws('|',
          COALESCE(p.name, ''), COALESCE(p.sku, ''), COALESCE(p.oem_number, ''),
          COALESCE(p.normalized_supplier_article, ''), COALESCE(brand.name, '')
        ))
        OR (
          state.status IN ('pending', 'failed')
          AND state.attempt_count < 3
          AND state.next_retry_at <= now()
        )
      )
    GROUP BY p.tenant_id
    ORDER BY oldest_at, p.tenant_id
    LIMIT 1
  ) AS candidate;

  IF v_tenant_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      p.tenant_id,
      p.id AS product_id,
      md5(concat_ws('|',
        COALESCE(p.name, ''), COALESCE(p.sku, ''), COALESCE(p.oem_number, ''),
        COALESCE(p.normalized_supplier_article, ''), COALESCE(brand.name, '')
      )) AS source_fingerprint,
      p.sku::TEXT AS sku,
      p.name::TEXT AS name,
      p.oem_number::TEXT AS oem_number,
      p.normalized_supplier_article::TEXT AS supplier_article,
      brand.name::TEXT AS brand_name
    FROM public.products AS p
    LEFT JOIN public.brands AS brand ON brand.id = p.brand_id
    LEFT JOIN public.product_cross_enrichment_state AS state
      ON state.tenant_id = p.tenant_id
     AND state.product_id = p.id
    WHERE p.tenant_id = v_tenant_id
      AND p.deleted_at IS NULL
      AND p.is_active = true
      AND COALESCE(p.is_service, false) = false
      AND p.sku NOT ILIKE 'POS-%'
      AND (
        state.product_id IS NULL
        OR state.source_fingerprint <> md5(concat_ws('|',
          COALESCE(p.name, ''), COALESCE(p.sku, ''), COALESCE(p.oem_number, ''),
          COALESCE(p.normalized_supplier_article, ''), COALESCE(brand.name, '')
        ))
        OR (
          state.status IN ('pending', 'failed')
          AND state.attempt_count < 3
          AND state.next_retry_at <= now()
        )
      )
    ORDER BY COALESCE(state.updated_at, p.created_at), p.id
    LIMIT v_batch_size
    FOR UPDATE OF p SKIP LOCKED
  ), claimed AS (
    INSERT INTO public.product_cross_enrichment_state AS state (
      tenant_id, product_id, source_fingerprint, status, attempt_count,
      next_retry_at, locked_at, locked_by, last_error, updated_at
    )
    SELECT
      candidate.tenant_id, candidate.product_id, candidate.source_fingerprint,
      'processing', 1, now(), now(), p_worker_id, NULL, now()
    FROM candidates AS candidate
    ON CONFLICT (tenant_id, product_id) DO UPDATE
    SET source_fingerprint = EXCLUDED.source_fingerprint,
        status = 'processing',
        attempt_count = CASE
          WHEN state.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint THEN 1
          ELSE state.attempt_count + 1
        END,
        next_retry_at = now(),
        locked_at = now(),
        locked_by = p_worker_id,
        last_error = NULL,
        result_count = CASE
          WHEN state.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint THEN 0
          ELSE state.result_count
        END,
        processed_at = CASE
          WHEN state.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint THEN NULL
          ELSE state.processed_at
        END,
        updated_at = now()
    RETURNING state.tenant_id, state.product_id, state.source_fingerprint
  )
  SELECT
    claimed.tenant_id,
    claimed.product_id,
    claimed.source_fingerprint,
    candidate.sku,
    candidate.name,
    candidate.oem_number,
    candidate.supplier_article,
    candidate.brand_name
  FROM claimed
  JOIN candidates AS candidate
    ON candidate.tenant_id = claimed.tenant_id
   AND candidate.product_id = claimed.product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_product_cross_enrichment(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_product_cross_enrichment(TEXT, INTEGER)
  TO service_role;

-- Replace only system-generated AUTO articles and only when the candidate is
-- present in the product name. The unique products constraint remains the last
-- line of defence against assigning an article owned by another card.
CREATE OR REPLACE FUNCTION public.set_product_sku_from_ai(
  p_tenant_id UUID,
  p_product_id UUID,
  p_expected_sku TEXT,
  p_new_sku TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_normalized_name TEXT;
  v_normalized_sku TEXT;
BEGIN
  v_normalized_sku := UPPER(regexp_replace(COALESCE(p_new_sku, ''), '[^[:alnum:]]', '', 'g'));
  IF length(v_normalized_sku) < 4 OR length(v_normalized_sku) > 100 THEN
    RETURN false;
  END IF;

  SELECT UPPER(regexp_replace(COALESCE(name, ''), '[^[:alnum:]]', '', 'g'))
  INTO v_normalized_name
  FROM public.products
  WHERE id = p_product_id
    AND tenant_id = p_tenant_id
    AND deleted_at IS NULL
    AND sku = p_expected_sku
    AND sku ~* '^AUTO-';

  IF NOT FOUND OR position(v_normalized_sku IN v_normalized_name) = 0 THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.products
    WHERE tenant_id = p_tenant_id
      AND UPPER(regexp_replace(COALESCE(sku, ''), '[^[:alnum:]]', '', 'g')) = v_normalized_sku
      AND id <> p_product_id
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.products
  SET sku = v_normalized_sku,
      updated_at = now()
  WHERE id = p_product_id
    AND tenant_id = p_tenant_id
    AND deleted_at IS NULL
    AND sku = p_expected_sku
    AND sku ~* '^AUTO-';

  RETURN FOUND;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.set_product_sku_from_ai(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_product_sku_from_ai(UUID, UUID, TEXT, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
