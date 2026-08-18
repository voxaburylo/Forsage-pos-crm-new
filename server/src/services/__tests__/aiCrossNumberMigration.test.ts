import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../../../', import.meta.url)
const migration = readFileSync(
  new URL('supabase/migrations/20260818054448_ai_cross_number_enrichment.sql', root),
  'utf8',
)
const priorityMigration = readFileSync(
  new URL('supabase/migrations/20260818094500_prioritize_ai_cross_catalog_candidates.sql', root),
  'utf8',
)
const route = readFileSync(new URL('server/src/routes/internalAi.ts', root), 'utf8')
const vercel = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'))

describe('AI cross-number background safety', () => {
  it('keeps enrichment state private, bounded and idempotent', () => {
    expect(migration).toContain('ALTER TABLE public.product_cross_enrichment_state ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('REVOKE ALL ON public.product_cross_enrichment_state FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('PRIMARY KEY (tenant_id, product_id)')
    expect(migration).toContain("pg_try_advisory_xact_lock(hashtext('product_cross_enrichment_claim'))")
    expect(migration).toContain('LEAST(GREATEST(COALESCE(p_batch_size, 5), 1), 5)')
    expect(migration).toContain("state.status IN ('pending', 'failed')")
    expect(migration).not.toContain('USING (true)')
  })

  it('updates only an AUTO article that occurs in the product name and has no duplicate', () => {
    expect(migration).toContain("sku ~* '^AUTO-'")
    expect(migration).toContain('position(v_normalized_sku IN v_normalized_name) = 0')
    expect(migration).toContain('UPPER(regexp_replace')
    expect(migration).toContain('WHEN unique_violation THEN')
  })

  it('processes generated articles with catalog-like numbers in the name first', () => {
    expect(priorityMigration).toContain("WHEN p.sku ~* '^AUTO-'")
    expect(priorityMigration).toContain("p.name ~* '([[:alpha:]]")
    expect(priorityMigration).toContain('THEN 0')
    expect(priorityMigration).toContain('ON CONFLICT ON CONSTRAINT product_cross_enrichment_state_pkey')
  })

  it('protects the cron route with CRON_SECRET and runs only once a day', () => {
    expect(route).toContain('timingSafeEqual')
    expect(route).toContain('process.env.CRON_SECRET')
    expect(route).toContain("res.setHeader('Cache-Control', 'no-store')")
    expect(vercel.crons).toEqual([
      { path: '/api/v1/internal/ai-cross-enrichment', schedule: '17 2 * * *' },
    ])
  })
})
