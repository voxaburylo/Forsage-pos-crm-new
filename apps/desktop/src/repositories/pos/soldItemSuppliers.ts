import type { LocalDatabase } from '../../db/localDatabase'

type Supplier = { id: string; name: string }

// Reorder sources, not batch accounting. Enrich after aggregation so repeated
// receipts and multiple suppliers can never multiply sale quantities or money.
export function soldItemSuppliers(db: Pick<LocalDatabase, 'prepare'>, tenantId: string, productIds: string[]) {
  const result = new Map<string, Supplier[]>()
  const ids = [...new Set(productIds)]
  for (let offset = 0; offset < ids.length; offset += 300) {
    const chunk = ids.slice(offset, offset + 300)
    const rows = db.prepare(`
      SELECT DISTINCT ii.product_id, s.id, s.name
      FROM supply_invoice_items ii
      JOIN supply_invoices i ON i.id = ii.invoice_id AND i.tenant_id = ii.tenant_id
      JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id
      WHERE ii.tenant_id = ? AND ii.deleted_at IS NULL AND ii.qty > 0
        AND i.deleted_at IS NULL AND i.status = 'posted'
        AND s.deleted_at IS NULL
        AND ii.product_id IN (${chunk.map(() => '?').join(',')})
      ORDER BY s.name, s.id
    `).all(tenantId, ...chunk) as Array<Supplier & { product_id: string }>
    for (const row of rows) {
      const suppliers = result.get(row.product_id) ?? []
      suppliers.push({ id: row.id, name: row.name })
      result.set(row.product_id, suppliers)
    }
  }
  for (const suppliers of result.values()) suppliers.sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.id.localeCompare(b.id))
  return result
}
