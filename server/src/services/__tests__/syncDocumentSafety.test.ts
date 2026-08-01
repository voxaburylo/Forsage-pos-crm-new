import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const supplierSource = readFileSync(new URL('../supplierService.ts', import.meta.url), 'utf8')
const inventoryRouteSource = readFileSync(new URL('../../routes/inventory.ts', import.meta.url), 'utf8')
const inventorySyncMigration = readFileSync(
  new URL('../../../../supabase/migrations/20260729110000_inventory_session_sync.sql', import.meta.url),
  'utf8',
)
const migrationSource = readFileSync(
  new URL('../../../../supabase/migrations/20260729073000_supply_invoice_soft_delete_sync.sql', import.meta.url),
  'utf8',
)

describe('document synchronization safety', () => {
  it('returns invoice tombstones and the complete current rows of changed invoices', () => {
    expect(syncSource).toContain('deleted_supply_invoice_ids: deletedSupplyInvoiceIds')
    expect(syncSource).toContain('supplyInvoices.filter((row: any) => !row.deleted_at)')
    expect(syncSource).toContain(".in('invoice_id', ids)")
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

  it('synchronizes the full inventory-session lifecycle and deletion tombstones', () => {
    for (const operation of ['inventory.created', 'inventory.started', 'inventory.deleted']) {
      expect(syncSource).toContain(`operation.operation_type === '${operation}'`)
    }
    expect(syncSource).toContain('deleted_inventory_session_ids: deletedInventorySessions.map')
    expect(syncSource).toContain("VALUES ($1, 'inventory_session', $2, clock_timestamp())")
    expect(inventoryRouteSource).toContain("VALUES ($1, 'inventory_session', $2, clock_timestamp())")
    expect(inventoryRouteSource).toContain('SELECT status FROM inventory_sessions')
    expect(inventorySyncMigration).toContain("'inventory_session'")
  })
  it('releases active stock reserves when a synchronized order is deleted', () => {
    const start = syncSource.indexOf('async function applyOrderDeleted')
    const end = syncSource.indexOf('async function applyOrderStatusUpdated', start)
    expect(syncSource.slice(start, end)).toContain('UPDATE inventory_reserves')
  })
})
