import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const supplierSource = readFileSync(new URL('../supplierService.ts', import.meta.url), 'utf8')
const migrationSource = readFileSync(
  new URL('../../../../supabase/migrations/20260729073000_supply_invoice_soft_delete_sync.sql', import.meta.url),
  'utf8',
)

describe('document synchronization safety', () => {
  it('returns invoice tombstones and the complete current rows of changed invoices', () => {
    expect(syncSource).toContain('deleted_supply_invoice_ids: deletedSupplyInvoiceIds')
    expect(syncSource).toContain("query = query.gt('invoice.updated_at', since)")
    expect(syncSource).toContain(".is('invoice.deleted_at', null)")
  })

  it('soft-deletes supply invoices instead of losing the deletion event', () => {
    const start = syncSource.indexOf('async function applySupplierInvoiceDeleted')
    const end = syncSource.indexOf('async function applyShiftOpened', start)
    const block = syncSource.slice(start, end)
    expect(block).toContain('SET deleted_at = $3, updated_at = $3')
    expect(block).not.toContain('DELETE FROM supply_invoices')

    const supplierDelete = supplierSource.slice(
      supplierSource.indexOf('export async function deleteSupplyInvoice'),
      supplierSource.indexOf('// ===================== Замовлення постачальникам'),
    )
    expect(supplierDelete).toContain('.update({ deleted_at: deletedAt, updated_at: deletedAt })')
    expect(migrationSource).toContain('ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ')
  })

  it('releases active stock reserves when a synchronized order is deleted', () => {
    const start = syncSource.indexOf('async function applyOrderDeleted')
    const end = syncSource.indexOf('async function applyOrderStatusUpdated', start)
    expect(syncSource.slice(start, end)).toContain('UPDATE inventory_reserves')
  })
})
