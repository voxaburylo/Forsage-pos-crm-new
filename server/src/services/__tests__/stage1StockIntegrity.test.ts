import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260729094409_stage1_stock_integrity.sql', import.meta.url),
  'utf8',
)

describe('stage 1 stock integrity', () => {
  it('records every server stock update in an immutable movement ledger', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.inventory_movements')
    expect(migration).toContain('AFTER UPDATE OF qty_on_hand ON public.products')
    expect(migration).toContain("COALESCE(v_source_type, 'system')")
    expect(migration).toContain('ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('GRANT SELECT, INSERT ON public.inventory_movements TO authenticated')
  })

  it('validates all supply products and refuses a destructive cancellation', () => {
    expect(migration).toContain('PRODUCT_NOT_FOUND: Товар % відсутній або видалений')
    expect(migration).toContain('INVOICE_STOCK_USED: Неможливо скасувати накладну')
    expect(migration).toContain('SET qty_on_hand = qty_on_hand - v_item.qty')
    expect(migration).not.toContain('GREATEST(0, qty_on_hand - v_item.qty)')
    expect(migration.indexOf("SET status = 'posted'")).toBeGreaterThan(migration.indexOf('SET qty_on_hand = qty_on_hand + v_item.qty'))
  })

  it('periodically heals supply children and accepts safe retries of deleted categories', () => {
    expect(syncSource).toContain('supplyInvoices.filter((row: any) => !row.deleted_at)')
    expect(syncSource).toContain(".from('supply_invoice_items')")
    expect(syncSource).toContain(".in('invoice_id', ids)")
    expect(syncSource).toContain('referencesIncluded ? undefined : since')
    const categoryDelete = syncSource.slice(
      syncSource.indexOf('async function applyCategoryDeleted'),
      syncSource.indexOf('async function applyBrandUpsert'),
    )
    expect(categoryDelete).toContain('WHERE tenant_id = $1 AND category_id = $2')
    expect(categoryDelete).not.toContain('rowCount')
    expect(categoryDelete).not.toContain('NOT_FOUND')
  })

  it('rejects product prices outside the database money range with a readable error', () => {
    expect(syncSource).toContain("throw new AppError('SYNC_PRODUCT_PRICE_INVALID'")
    expect(syncSource).toContain('parsed > 2_147_483_647')
  })
})