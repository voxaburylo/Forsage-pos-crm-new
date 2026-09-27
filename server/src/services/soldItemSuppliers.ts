import { db } from '../db/supabase.js'
import { readReportPages } from '../lib/readReportPages.js'
import { AppError } from '../middleware/errorHandler.js'

type Supplier = { id: string; name: string }

// Supplier history has no date limit: today's sale may use an older receipt.
// Tenant/deletion guards apply to every joined table, including with service_role.
export async function loadSoldItemSuppliers(tenantId: string, productIds: string[]) {
  const result = new Map<string, Supplier[]>()
  const ids = [...new Set(productIds)]
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await readReportPages(db.from('supply_invoice_items')
      .select('*, invoice:supply_invoices!inner(supplier:suppliers!inner(id,name))')
      .eq('tenant_id', tenantId).gt('qty', 0)
      .in('product_id', ids.slice(offset, offset + 100))
      .eq('invoice.tenant_id', tenantId).eq('invoice.status', 'posted').is('invoice.deleted_at', null)
      .eq('invoice.supplier.tenant_id', tenantId).is('invoice.supplier.deleted_at', null))
    if (error) throw new AppError('DB_ERROR', 'Не вдалося визначити постачальників: ' + error.message, 500)
    for (const row of data) {
      // Older cloud schemas have no item tombstone column. Wildcard includes it
      // when present; never query a missing column or silently revive deleted rows.
      if (row.deleted_at) continue
      const supplier = row.invoice?.supplier
      if (!supplier?.id) continue
      const suppliers = result.get(row.product_id) ?? []
      if (!suppliers.some(item => item.id === supplier.id)) suppliers.push({ id: supplier.id, name: supplier.name })
      result.set(row.product_id, suppliers)
    }
  }
  for (const suppliers of result.values()) suppliers.sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.id.localeCompare(b.id))
  return result
}
