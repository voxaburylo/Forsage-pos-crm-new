import type { LocalDatabase } from '../db/localDatabase'
import type { LocalSyncOutboxOperation } from '../db/localTypes'

/** One SQLite transaction gives all outgoing documents the same current source version. */
export function attachBalanceSnapshots(db: LocalDatabase, operations: LocalSyncOutboxOperation[], sign?: (text: string) => string): LocalSyncOutboxOperation[] {
  const copies = db.transaction(() => {
    // sqlite_sequence survives deletion of delivered/staff outbox rows.
    const version = Number((db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_outbox'),0) n").get() as { n: number }).n)
    const customersByTenant = new Map<string, unknown[]>()
    return operations.map(operation => {
      const payload = { ...(operation.payload ?? {}) }
      const ids = new Set<string>()
      if (operation.aggregate_type === 'product') ids.add(operation.aggregate_id)
      if (typeof payload.product_id === 'string') ids.add(payload.product_id)
      for (const item of Array.isArray(payload.items) ? payload.items : []) {
        if (typeof item?.product_id === 'string') ids.add(item.product_id)
      }
      // Cancellation payloads contain just a document ID. Their current stock is
      // still authoritative; resolve references from the local document, never cloud.
      const documentTables: Record<string, [string, string]> = {
        supply_invoice: ['supply_invoice_items', 'invoice_id'],
        customer_order: ['customer_order_items', 'order_id'],
        inventory_session: ['inventory_items', 'session_id'],
      }
      const document = documentTables[operation.aggregate_type]
      if (document) {
        for (const row of db.prepare(`SELECT product_id FROM ${document[0]} WHERE ${document[1]}=? AND tenant_id=?`)
          .all(operation.aggregate_id, operation.tenant_id) as Array<{product_id: string | null}>) {
          if (row.product_id) ids.add(row.product_id)
        }
      }
      if (operation.operation_type === 'customer.deposit_changed' || (operation.operation_type === 'order.payment_added' && payload.method === 'account')) {
        const transaction = db.prepare('SELECT balance_after FROM customer_deposit_transactions WHERE id=? AND tenant_id=?')
          .get(payload.transaction_id ?? payload.account_transaction_id ?? operation.operation_id, operation.tenant_id) as {balance_after:number} | undefined
        if (transaction) payload.balance_after = transaction.balance_after
      }
      const products: unknown[] = []
      const productIds = [...ids]
      for (let start=0; start<productIds.length; start+=400) {
        const part=productIds.slice(start,start+400)
        products.push(...db.prepare(`SELECT id,qty_on_hand FROM products WHERE tenant_id=? AND id IN (${part.map(()=>'?').join(',')})`)
          .all(operation.tenant_id,...part))
      }
      if (!customersByTenant.has(operation.tenant_id)) {
        customersByTenant.set(operation.tenant_id, db.prepare(`SELECT id, COALESCE(debt_balance,0) debt_balance,
          COALESCE(deposit_balance,0) deposit_balance, COALESCE(bonus_balance,0) bonus_balance
          FROM customers WHERE tenant_id=?`).all(operation.tenant_id))
      }
      const snapshot = {
        source_version: version, products, customers: customersByTenant.get(operation.tenant_id),
      }
      return { ...operation, payload: { ...payload, local_balance_snapshot: snapshot } }
    })
  })
  // DPAPI and key-file I/O must not extend the SQLite transaction.
  return copies.map(operation => {
    const snapshot=operation.payload.local_balance_snapshot
    const signature=sign?.(JSON.stringify({tenant_id:operation.tenant_id,device_id:db.deviceId,snapshot}))
    return {...operation,payload:{...operation.payload,local_balance_snapshot:{...snapshot,signature}}}
  })
}
