import { syncModuleSource as syncSource } from './helpers/syncSource.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routeSource = readFileSync(new URL('../../routes/sync.ts', import.meta.url), 'utf8')
const adminSource = readFileSync(new URL('../adminService.ts', import.meta.url), 'utf8')
const saleRouteSource = readFileSync(new URL('../../routes/sales.ts', import.meta.url), 'utf8')
const saleSource = readFileSync(new URL('../saleService.ts', import.meta.url), 'utf8')
const generationSource = readFileSync(new URL('../syncGeneration.ts', import.meta.url), 'utf8')
const authSource = readFileSync(new URL('../../middleware/auth.ts', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260801090000_sync_keyset_reference_deltas.sql', import.meta.url),
  'utf8',
)

describe('tenant reset generation safety', () => {
  it('requires the client generation for incremental pull and push', () => {
    expect(routeSource).toContain('reset_generation: z.coerce.number().int().nonnegative().optional().default(0)')
    expect(routeSource).toContain('resetGeneration: parsed.data.reset_generation')
    expect(syncSource).toContain('since && resetGeneration !== syncState.generation')
    expect(syncSource).toContain('withTenantSyncGenerationGuard')
    expect(generationSource).toContain('clientGeneration !== state.generation')
  })

  it('terminally discards every operation from another generation', () => {
    const push = syncSource.slice(
      syncSource.indexOf('export async function pushLocalOperations'),
      syncSource.indexOf('async function applyLocalOperation'),
    )
    expect(push).toContain("status: 'discarded'")
    expect(push).toContain("error_code: 'SYNC_RESET_REQUIRED'")
    expect(push).not.toContain('createdAtMs <= resetAtMs')
    expect(push).toContain('reset_required: true')
  })

  it('reads applied_at from the database immediately before every operation', () => {
    expect(syncSource).toContain("'SELECT clock_timestamp() AS applied_at'")
    const push = syncSource.slice(
      syncSource.indexOf('export async function pushLocalOperations'),
      syncSource.indexOf('async function applyLocalOperation'),
    )
    expect(push).toContain('const appliedAt = await captureDatabaseAppliedAt()')
    expect(push).toContain('applied_at: appliedAt')
  })

  it('holds the reset generation row lock across the complete push batch', () => {
    expect(generationSource).toContain('withTenantSyncGenerationGuard')
    expect(generationSource).toContain('FOR SHARE')
    expect(generationSource).toContain('generationGuardLimit')
    expect(generationSource).toContain('acquireGenerationGuardPermit')
    const guard = generationSource.slice(
      generationSource.indexOf('export async function withTenantSyncGenerationGuard'),
      generationSource.indexOf('export async function assertTenantSyncGenerationInTransaction'),
    )
    expect(guard.indexOf("client.query('BEGIN')")).toBeLessThan(guard.indexOf('await work(state)'))
    expect(guard.indexOf('await work(state)')).toBeLessThan(guard.indexOf("client.query('COMMIT')", guard.indexOf('await work(state)')))
    const push = syncSource.slice(syncSource.indexOf('export async function pushLocalOperations'), syncSource.indexOf('async function applyLocalOperation'))
    expect(push.indexOf('withTenantSyncGenerationGuard')).toBeLessThan(push.indexOf('processSyncBatch(params.operations'))
  })

  it('guards direct POS sales before work and inside the committing transaction', () => {
    expect(saleRouteSource).toContain("req.get('X-Sync-Reset-Generation')")
    expect(saleRouteSource).toContain('await assertTenantSyncGeneration')
    expect(saleSource).toContain('await assertTenantSyncGenerationInTransaction')
    expect(generationSource).toContain("'SYNC_RESET_REQUIRED'")
  })

  it('commits the reset marker atomically outside the destructive delete list', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.sync_tenant_generations')
    expect(adminSource).toContain('INSERT INTO sync_tenant_generations')
    expect(adminSource.indexOf('INSERT INTO sync_tenant_generations'))
      .toBeLessThan(adminSource.indexOf('for (const table of tablesToDelete)'))
    expect(adminSource).not.toContain("{ name: 'sync_tenant_generations'")
    expect(adminSource).toContain("{ name: 'inventory_movements'")
    expect(adminSource).toContain("{ name: 'customer_deposit_transactions'")
    expect(adminSource).toContain("{ name: 'sync_deletions'")

  })

  it('cleans only exact product-photo objects and re-lists Auth users after commit', () => {
    const reset = adminSource.slice(adminSource.indexOf('export async function resetAllData'))
    expect(reset).toContain('SELECT photo_url AS url')
    expect(reset).toContain('JOIN products AS product ON product.id = photo.product_id')
    expect(adminSource).toContain("'/storage/v1/object/public/product-photos/'")
    expect(adminSource).toContain("storage.from('product-photos').remove(chunk)")
    expect(reset.indexOf("client.query('COMMIT')")).toBeLessThan(reset.lastIndexOf('await listAllAuthUsers()'))
    expect(reset).toContain('await clearProductSearchCache()')
  })

  it('blocks every ordinary mutation while reset is active', () => {
    expect(migration).toContain('resetting_at TIMESTAMPTZ')
    expect(generationSource).toContain('beginTenantReset')
    expect(generationSource).toContain('acquireTenantMutationGuard')
    expect(generationSource).toContain("'TENANT_RESET_IN_PROGRESS'")
    expect(authSource).toContain("method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'")
    expect(authSource).toContain("requestPath(req) === '/api/v1/admin/reset-all-data'")
    expect(authSource).toContain("path === '/api/v1/sync/push' || path === '/api/v1/sales'")
    const reset = adminSource.slice(adminSource.indexOf('export async function resetAllData'))
    expect(reset).toContain('await beginTenantReset(tenantId)')
    expect(reset).toContain('await clearTenantResetMarker(tenantId)')
  })

  it('revalidates pre-reset JWTs and paginates Auth administration', () => {
    expect(authSource).toContain('iat?: number')
    expect(authSource).toContain('tokenPredatesReset')
    expect(authSource).toContain('await loadRemoteUser(token)')
    expect(authSource).toContain('currentUser.tenant_id !== originalTenantId')
    expect(adminSource).toContain('perPage: AUTH_LIST_PAGE_SIZE')
    expect(adminSource).toContain('for (let page = 1; ; page += 1)')
    const reset = adminSource.slice(adminSource.indexOf('export async function resetAllData'))
    expect(reset.indexOf('updateUserById(user.id')).toBeLessThan(reset.indexOf('deleteUser(user.id)'))
    expect(reset).toContain('users_revocation_failed')
    expect(reset).toContain('success: authDeleteErrors.length === 0')
  })

  it('avoids a table-wide timestamp backfill in the release migration', () => {
    expect(migration).toContain("DEFAULT '1970-01-01 00:00:00+00'")
    expect(migration).not.toMatch(/UPDATE public\.[a-z_]+ SET updated_at/)
    expect(migration).toContain('ALTER COLUMN updated_at SET DEFAULT clock_timestamp()')
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON public.sync_deletions')
    expect(migration).toContain('NEW.deleted_at := clock_timestamp()')
    expect(migration).toContain('NEW.updated_at := clock_timestamp()')
  })

  it('adapts the legacy vehicle schema without dropping duplicate VIN history', () => {
    expect(migration).toContain('NULL::TIMESTAMPTZ')
    expect(migration).toContain("ALTER TABLE public.customer_cars\n  ADD COLUMN IF NOT EXISTS updated_at")
    expect(migration).toContain('WITH ranked_vins AS')
    expect(migration).toContain('ORDER BY created_at DESC NULLS LAST, id DESC')
    expect(migration).toContain('SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()')
    expect(migration).toContain('ranked.position > 1')
  })
})
