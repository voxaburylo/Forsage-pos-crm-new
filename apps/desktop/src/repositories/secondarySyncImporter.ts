import type { LocalDatabase } from '../db/localDatabase'

type SnapshotOptions = {
  catalogStructure?: boolean
  staff?: boolean
  commissionRules?: boolean
  salaryPayments?: boolean
  stockReserves?: boolean
}

export type SecondarySyncCounts = {
  staff_pins: number
  deleted_categories: number
  deleted_brands: number
  deleted_staff: number
  commission_rules: number
  deleted_commission_rules: number
  salary_payments: number
  deleted_salary_payments: number
  cash_operations: number
  deleted_cash_operations: number
  customer_returns: number
  customer_return_items: number
  stock_reserves: number
  deleted_stock_reserves: number
  warehouse_movements: number
  writeoffs: number
  writeoff_items: number
  bonus_transactions: number
  customer_deposit_transactions: number
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asTimestamp(value: unknown, fallback: string): string {
  return asText(value) ?? fallback
}

function sameInstant(left: unknown, right: unknown): boolean {
  const leftTime = Date.parse(String(left ?? ''))
  const rightTime = Date.parse(String(right ?? ''))
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

export class LocalSecondarySyncImporter {
  constructor(private readonly db: LocalDatabase) {}

  apply(tenantId: string, source: Record<string, any>, importedAt: string, snapshots: SnapshotOptions = {}): SecondarySyncCounts {
    const counts: SecondarySyncCounts = {
      staff_pins: 0,
      deleted_categories: 0,
      deleted_brands: 0,
      deleted_staff: 0,
      commission_rules: 0,
      deleted_commission_rules: 0,
      salary_payments: 0,
      deleted_salary_payments: 0,
      cash_operations: 0,
      deleted_cash_operations: 0,
      customer_returns: 0,
      customer_return_items: 0,
      stock_reserves: 0,
      deleted_stock_reserves: 0,
      warehouse_movements: 0,
      writeoffs: 0,
      writeoff_items: 0,
      bonus_transactions: 0,
      customer_deposit_transactions: 0,
    }

    if (snapshots.catalogStructure) {
      counts.deleted_categories = this.pruneCleanMissing('categories', tenantId, source.categories, importedAt)
      counts.deleted_brands = this.pruneCleanMissing('brands', tenantId, source.brands, importedAt)
    }
    if (snapshots.staff) {
      counts.deleted_staff = this.pruneCleanMissing('staff_users', tenantId, source.staff, importedAt, true)
    }
    for (const pin of source.staff_pins ?? []) {
      if (this.upsertStaffPin(tenantId, pin)) counts.staff_pins++
    }

    for (const rule of source.commission_rules ?? []) {
      if (this.upsertCommissionRule(tenantId, rule, importedAt)) counts.commission_rules++
    }
    if (snapshots.commissionRules) {
      counts.deleted_commission_rules = this.pruneCleanMissing(
        'commission_rules', tenantId, source.commission_rules, importedAt,
      )
    }

    for (const operation of source.cash_operations ?? []) {
      if (this.upsertCashOperation(tenantId, operation, importedAt)) counts.cash_operations++
    }    counts.deleted_cash_operations += this.markDeletedIds(
      'cash_operations', tenantId, source.deleted_cash_operation_ids, importedAt,
    )


    const cleanReturnIds = new Set<string>()
    for (const customerReturn of source.customer_returns ?? []) {
      if (this.upsertCustomerReturn(tenantId, customerReturn, importedAt)) {
        counts.customer_returns++
        cleanReturnIds.add(String(customerReturn.id))
      }
    }
    for (const returnId of cleanReturnIds) {
      this.db.prepare('DELETE FROM customer_return_items WHERE tenant_id = ? AND return_id = ?')
        .run(tenantId, returnId)
    }
    for (const item of source.customer_return_items ?? []) {
      if (!cleanReturnIds.has(String(item.return_id))) continue
      if (this.upsertCustomerReturnItem(tenantId, item, importedAt)) counts.customer_return_items++
    }

    for (const reserve of source.stock_reserves ?? []) {
      if (this.upsertStockReserve(tenantId, reserve, importedAt)) counts.stock_reserves++
    }
    if (snapshots.stockReserves) {
      counts.deleted_stock_reserves = this.pruneCleanMissing(
        'stock_reserves', tenantId, source.stock_reserves, importedAt,
      )
    }

    for (const movement of source.warehouse_movements ?? []) {
      if (this.upsertWarehouseMovement(tenantId, movement, importedAt)) counts.warehouse_movements++
    }

    const cleanWriteoffIds = new Set<string>()
    for (const writeoff of source.writeoffs ?? []) {
      if (this.upsertWriteoff(tenantId, writeoff, importedAt)) {
        counts.writeoffs++
        cleanWriteoffIds.add(String(writeoff.id))
      }
    }
    for (const writeoffId of cleanWriteoffIds) {
      this.db.prepare('DELETE FROM writeoff_items WHERE tenant_id = ? AND writeoff_id = ?')
        .run(tenantId, writeoffId)
    }
    for (const item of source.writeoff_items ?? []) {
      if (!cleanWriteoffIds.has(String(item.writeoff_id))) continue
      if (this.upsertWriteoffItem(tenantId, item, importedAt)) counts.writeoff_items++
    }

    for (const transaction of source.bonus_transactions ?? []) {
      if (this.upsertBonusTransaction(tenantId, transaction, importedAt)) counts.bonus_transactions++
    }
    for (const transaction of source.customer_deposit_transactions ?? []) {
      if (this.upsertDepositTransaction(tenantId, transaction, importedAt)) counts.customer_deposit_transactions++
    }

    for (const payment of source.salary_payments ?? []) {
      if (this.upsertSalaryPayment(tenantId, payment, importedAt)) counts.salary_payments++
    }
    if (snapshots.salaryPayments) {
      counts.deleted_salary_payments += this.pruneCleanMissing(
        'salary_payments', tenantId, source.salary_payments, importedAt,
      )
    }
    counts.deleted_salary_payments += this.markDeletedIds(
      'salary_payments', tenantId, source.deleted_salary_payment_ids, importedAt,
    )

    return counts
  }

  private upsertStaffPin(tenantId: string, pin: any): boolean {
    const userId = asText(pin?.user_id)
    const pinHash = asText(pin?.pin_hash)
    if (!userId || !pinHash || !/^[0-9a-f]{128}$/i.test(pinHash)) return false
    if (!this.exists('staff_users', tenantId, userId)) return false
    const pending = this.db.prepare(`
      SELECT 1 FROM sync_outbox
      WHERE tenant_id = ? AND aggregate_type = 'staff_pin' AND aggregate_id = ?
        AND operation_type = 'staff_pin.updated' AND status IN ('pending', 'failed', 'sending')
      LIMIT 1
    `).get(tenantId, userId)
    if (pending) return false
    const result = this.db.prepare(`
      UPDATE staff_users
      SET pin_hash = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(pinHash, userId, tenantId)
    return Number(result.changes) > 0
  }

  private markDeletedIds(
    table: 'salary_payments' | 'cash_operations',
    tenantId: string,
    ids: unknown,
    importedAt: string,
  ): number {
    if (!Array.isArray(ids)) return 0
    let deleted = 0
    for (const value of ids) {
      const id = asText(value)
      if (!id) continue
      const result = this.db.prepare(`
        UPDATE ${table}
        SET deleted_at = ?, updated_at = ?, remote_updated_at = ?
        WHERE id = ? AND tenant_id = ? AND dirty_at IS NULL
          AND (deleted_at IS NULL OR deleted_at < ?)
      `).run(importedAt, importedAt, importedAt, id, tenantId, importedAt)
      deleted += Number(result.changes)
    }
    return deleted
  }
  private pruneCleanMissing(
    table: 'categories' | 'brands' | 'staff_users' | 'commission_rules' | 'salary_payments' | 'stock_reserves',
    tenantId: string,
    remoteRows: any[] | undefined,
    importedAt: string,
    deactivate = false,
  ): number {
    const remoteIds = new Set((remoteRows ?? []).map((row) => String(row?.id ?? '')).filter(Boolean))
    const localRows = this.db.prepare(`
      SELECT id FROM ${table}
      WHERE tenant_id = ? AND dirty_at IS NULL AND deleted_at IS NULL
    `).all(tenantId) as Array<{ id: string }>
    let deleted = 0
    for (const row of localRows) {
      if (remoteIds.has(row.id)) continue
      const result = this.db.prepare(`
        UPDATE ${table}
        SET deleted_at = ?, updated_at = ?, remote_updated_at = ?${deactivate ? ', is_active = 0' : ''}
        WHERE id = ? AND tenant_id = ? AND dirty_at IS NULL AND deleted_at IS NULL
      `).run(importedAt, importedAt, importedAt, row.id, tenantId)
      deleted += Number(result.changes)
    }
    return deleted
  }

  private exists(table: string, tenantId: string, id: unknown): boolean {
    const normalizedId = asText(id)
    if (!normalizedId) return false
    return Boolean(this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`).get(normalizedId, tenantId))
  }

  private isDirty(table: string, tenantId: string, id: unknown): boolean {
    const normalizedId = asText(id)
    if (!normalizedId) return false
    const row = this.db.prepare(`SELECT dirty_at FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`)
      .get(normalizedId, tenantId) as { dirty_at: string | null } | undefined
    return Boolean(row?.dirty_at)
  }

  private upsertCommissionRule(tenantId: string, rule: any, importedAt: string): boolean {
    if (!asText(rule?.id) || this.isDirty('commission_rules', tenantId, rule.id)) return false
    if (rule.user_id && !this.exists('staff_users', tenantId, rule.user_id)) return false
    if (rule.brand_id && !this.exists('brands', tenantId, rule.brand_id)) return false
    if (rule.category_id && !this.exists('categories', tenantId, rule.category_id)) return false
    const updatedAt = asTimestamp(rule.updated_at ?? rule.created_at, importedAt)
    this.db.prepare(`
      INSERT INTO commission_rules (
        id, tenant_id, user_id, brand_id, category_id, pct_from_revenue,
        pct_from_profit, rule_type, remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        brand_id = excluded.brand_id,
        category_id = excluded.category_id,
        pct_from_revenue = excluded.pct_from_revenue,
        pct_from_profit = excluded.pct_from_profit,
        rule_type = excluded.rule_type,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE commission_rules.dirty_at IS NULL
    `).run(
      rule.id, tenantId, rule.user_id ?? null, rule.brand_id ?? null, rule.category_id ?? null,
      asNumber(rule.pct_from_revenue), asNumber(rule.pct_from_profit), rule.rule_type ?? 'personal_sales',
      updatedAt, rule.created_at ?? updatedAt, updatedAt,
    )
    return true
  }

  private upsertCashOperation(tenantId: string, operation: any, importedAt: string): boolean {
    const id = asText(operation?.id)
    const amount = Math.round(asNumber(operation?.amount))
    if (!id || amount <= 0 || this.isDirty('cash_operations', tenantId, id)) return false
    const createdAt = asTimestamp(operation.created_at, importedAt)
    const direction = operation.type === 'out' ? 'out' : 'in'
    const type = direction === 'out' ? 'cash_out' : 'cash_in'
    const shiftId = operation.shift_id && this.exists('shifts', tenantId, operation.shift_id)
      ? operation.shift_id
      : null
    const source = ['cashbox', 'owner_funds', 'change_fund', 'bank_account', 'business_card', 'other']
      .includes(String(operation.source)) ? String(operation.source) : 'cashbox'

    const existingById = this.exists('cash_operations', tenantId, id)
    if (!existingById && this.hasEquivalentCashOperation(
      tenantId, shiftId, amount, direction, operation.created_by, createdAt,
    )) return false

    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        shift_id = excluded.shift_id,
        user_id = excluded.user_id,
        type = CASE
          WHEN cash_operations.type IN ('cash_in', 'cash_out') THEN excluded.type
          ELSE cash_operations.type
        END,
        source = excluded.source,
        amount = excluded.amount,
        notes = excluded.notes,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE cash_operations.dirty_at IS NULL
    `).run(
      id, tenantId, shiftId, operation.created_by ?? null, type, source, amount,
      operation.note ?? operation.notes ?? null, createdAt, createdAt, createdAt,
    )
    return true
  }

  private hasEquivalentCashOperation(
    tenantId: string,
    shiftId: string | null,
    amount: number,
    direction: 'in' | 'out',
    userId: unknown,
    createdAt: string,
  ): boolean {
    const rows = this.db.prepare(`
      SELECT type, user_id, created_at
      FROM cash_operations
      WHERE tenant_id = ? AND shift_id IS ? AND amount = ?
        AND dirty_at IS NULL AND deleted_at IS NULL
    `).all(tenantId, shiftId, amount) as Array<{ type: string; user_id: string | null; created_at: string }>
    const incomingUserId = asText(userId)
    return rows.some((row) => {
      const rowDirection = ['return_cash', 'cash_out', 'salary_payout', 'supplier_payment'].includes(row.type)
        ? 'out'
        : 'in'
      if (rowDirection !== direction || !sameInstant(row.created_at, createdAt)) return false
      return !incomingUserId || !row.user_id || row.user_id === incomingUserId
    })
  }

  private upsertCustomerReturn(tenantId: string, customerReturn: any, importedAt: string): boolean {
    const id = asText(customerReturn?.id)
    if (!id || this.isDirty('customer_returns', tenantId, id)) return false
    if (!this.exists('sales', tenantId, customerReturn.sale_id)) return false
    const createdAt = asTimestamp(customerReturn.created_at ?? customerReturn.approved_at, importedAt)
    const customerId = customerReturn.customer_id && this.exists('customers', tenantId, customerReturn.customer_id)
      ? customerReturn.customer_id
      : null
    this.db.prepare(`
      INSERT INTO customer_returns (
        id, tenant_id, sale_id, customer_id, return_type, reason, reason_note,
        refund_method, refund_kopecks, stock_action, status, approved_by,
        fiscal_number, remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        sale_id = excluded.sale_id,
        customer_id = excluded.customer_id,
        return_type = excluded.return_type,
        reason = excluded.reason,
        reason_note = excluded.reason_note,
        refund_method = excluded.refund_method,
        refund_kopecks = excluded.refund_kopecks,
        stock_action = excluded.stock_action,
        status = excluded.status,
        approved_by = excluded.approved_by,
        fiscal_number = excluded.fiscal_number,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE customer_returns.dirty_at IS NULL
    `).run(
      id, tenantId, customerReturn.sale_id, customerId, customerReturn.return_type ?? 'refund',
      customerReturn.reason ?? 'other', customerReturn.reason_note ?? null,
      customerReturn.refund_method ?? 'cash', Math.round(asNumber(customerReturn.refund_kopecks)),
      customerReturn.stock_action ?? 'return_to_stock', customerReturn.status ?? 'completed',
      customerReturn.approved_by ?? null, customerReturn.fiscal_number ?? null,
      createdAt, createdAt, createdAt,
    )
    return true
  }

  private upsertCustomerReturnItem(tenantId: string, item: any, importedAt: string): boolean {
    if (!asText(item?.id) || !this.exists('customer_returns', tenantId, item.return_id)) return false
    if (!item.sale_item_id || !this.exists('sale_items', tenantId, item.sale_item_id)) return false
    const productId = item.product_id && this.exists('products', tenantId, item.product_id)
      ? item.product_id
      : null
    const createdAt = asTimestamp(item.created_at, importedAt)
    this.db.prepare(`
      INSERT INTO customer_return_items (
        id, tenant_id, return_id, sale_item_id, product_id, quantity,
        unit_price_kopecks, total_kopecks, condition, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      item.id, tenantId, item.return_id, item.sale_item_id, productId,
      asNumber(item.quantity), Math.round(asNumber(item.unit_price_kopecks)),
      Math.round(asNumber(item.total_kopecks)), item.condition ?? 'good', createdAt, createdAt,
    )
    return true
  }

  private upsertStockReserve(tenantId: string, reserve: any, importedAt: string): boolean {
    const id = asText(reserve?.id)
    if (!id || this.isDirty('stock_reserves', tenantId, id)) return false
    if (!this.exists('products', tenantId, reserve.product_id)) return false
    const createdAt = asTimestamp(reserve.created_at, importedAt)
    const updatedAt = asTimestamp(reserve.released_at ?? reserve.created_at, importedAt)
    const orderId = reserve.order_id && this.exists('customer_orders', tenantId, reserve.order_id)
      ? reserve.order_id
      : null
    const customerId = reserve.customer_id && this.exists('customers', tenantId, reserve.customer_id)
      ? reserve.customer_id
      : null
    this.db.prepare(`
      INSERT INTO stock_reserves (
        id, tenant_id, product_id, order_id, customer_id, qty, reserved_by,
        expires_at, released_at, remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id,
        order_id = excluded.order_id,
        customer_id = excluded.customer_id,
        qty = excluded.qty,
        reserved_by = excluded.reserved_by,
        expires_at = excluded.expires_at,
        released_at = excluded.released_at,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE stock_reserves.dirty_at IS NULL
    `).run(
      id, tenantId, reserve.product_id, orderId, customerId,
      Math.max(0, asNumber(reserve.qty) - asNumber(reserve.picked_qty)),
      reserve.reserved_by ?? null, reserve.expires_at ?? null, reserve.released_at ?? null,
      updatedAt, createdAt, updatedAt,
    )
    return true
  }

  private upsertWarehouseMovement(tenantId: string, movement: any, importedAt: string): boolean {
    const id = asText(movement?.id)
    if (!id || this.isDirty('warehouse_movements', tenantId, id)) return false
    if (!this.exists('products', tenantId, movement.product_id) || !asText(movement.to_bin)) return false
    const createdAt = asTimestamp(movement.created_at, importedAt)
    this.db.prepare(`
      INSERT INTO warehouse_movements (
        id, tenant_id, product_id, from_bin, to_bin, qty, note, created_by,
        remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id,
        from_bin = excluded.from_bin,
        to_bin = excluded.to_bin,
        qty = excluded.qty,
        note = excluded.note,
        created_by = excluded.created_by,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE warehouse_movements.dirty_at IS NULL
    `).run(
      id, tenantId, movement.product_id, movement.from_bin ?? null, movement.to_bin,
      asNumber(movement.qty), movement.note ?? null, movement.moved_by ?? movement.created_by ?? null,
      createdAt, createdAt, createdAt,
    )
    return true
  }

  private upsertWriteoff(tenantId: string, writeoff: any, importedAt: string): boolean {
    const id = asText(writeoff?.id)
    if (!id || this.isDirty('writeoffs', tenantId, id)) return false
    const createdAt = asTimestamp(writeoff.created_at, importedAt)
    this.db.prepare(`
      INSERT INTO writeoffs (
        id, tenant_id, reason, notes, created_by, remote_updated_at,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        reason = excluded.reason,
        notes = excluded.notes,
        created_by = excluded.created_by,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE writeoffs.dirty_at IS NULL
    `).run(
      id, tenantId, writeoff.reason ?? 'other', writeoff.notes ?? null,
      writeoff.created_by ?? null, createdAt, createdAt, createdAt,
    )
    return true
  }

  private upsertWriteoffItem(tenantId: string, item: any, importedAt: string): boolean {
    if (!asText(item?.id) || !this.exists('writeoffs', tenantId, item.writeoff_id)) return false
    if (!this.exists('products', tenantId, item.product_id)) return false
    const createdAt = asTimestamp(item.created_at, importedAt)
    this.db.prepare(`
      INSERT INTO writeoff_items (
        id, tenant_id, writeoff_id, product_id, qty, cost_kopecks,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      item.id, tenantId, item.writeoff_id, item.product_id, asNumber(item.qty),
      Math.round(asNumber(item.cost_kopecks)), createdAt, createdAt,
    )
    return true
  }

  private upsertBonusTransaction(tenantId: string, transaction: any, importedAt: string): boolean {
    const id = asText(transaction?.id)
    if (!id || this.isDirty('bonus_transactions', tenantId, id)) return false
    if (!this.exists('customers', tenantId, transaction.customer_id)) return false
    const createdAt = asTimestamp(transaction.created_at, importedAt)
    const sourceSaleId = transaction.source_sale_id && this.exists('sales', tenantId, transaction.source_sale_id)
      ? transaction.source_sale_id
      : null
    const existingById = this.exists('bonus_transactions', tenantId, id)
    if (!existingById) {
      const equivalent = (this.db.prepare(`
        SELECT created_at FROM bonus_transactions
        WHERE tenant_id = ? AND customer_id = ? AND source_sale_id IS ?
          AND amount = ? AND transaction_type = ? AND dirty_at IS NULL AND deleted_at IS NULL
      `).all(
        tenantId, transaction.customer_id, sourceSaleId, Math.round(asNumber(transaction.amount)),
        transaction.transaction_type ?? 'manual',
      ) as Array<{ created_at: string }>).some((row) => sameInstant(row.created_at, createdAt))
      if (equivalent) return false
    }
    this.db.prepare(`
      INSERT INTO bonus_transactions (
        id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
        description, created_by, remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        customer_id = excluded.customer_id,
        amount = excluded.amount,
        transaction_type = excluded.transaction_type,
        source_sale_id = excluded.source_sale_id,
        description = excluded.description,
        created_by = excluded.created_by,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE bonus_transactions.dirty_at IS NULL
    `).run(
      id, tenantId, transaction.customer_id, Math.round(asNumber(transaction.amount)),
      transaction.transaction_type ?? 'manual', sourceSaleId, transaction.description ?? null,
      transaction.created_by ?? null, createdAt, createdAt, createdAt,
    )
    return true
  }

  private upsertDepositTransaction(tenantId: string, transaction: any, importedAt: string): boolean {
    const id = asText(transaction?.id)
    if (!id || this.isDirty('customer_deposit_transactions', tenantId, id)) return false
    if (!this.exists('customers', tenantId, transaction.customer_id)) return false
    const createdAt = asTimestamp(transaction.created_at, importedAt)
    const orderId = transaction.order_id && this.exists('customer_orders', tenantId, transaction.order_id)
      ? transaction.order_id
      : null
    const saleId = transaction.sale_id && this.exists('sales', tenantId, transaction.sale_id)
      ? transaction.sale_id
      : null
    const shiftId = transaction.shift_id && this.exists('shifts', tenantId, transaction.shift_id)
      ? transaction.shift_id
      : null
    const method = transaction.method ?? 'cash'
    const existingById = this.exists('customer_deposit_transactions', tenantId, id)
    if (!existingById) {
      const equivalent = (this.db.prepare(`
        SELECT created_at FROM customer_deposit_transactions
        WHERE tenant_id = ? AND customer_id = ? AND order_id IS ? AND sale_id IS ?
          AND amount = ? AND balance_after = ? AND method = ?
          AND dirty_at IS NULL AND deleted_at IS NULL
      `).all(
        tenantId, transaction.customer_id, orderId, saleId, Math.round(asNumber(transaction.amount)),
        Math.round(asNumber(transaction.balance_after)), method,
      ) as Array<{ created_at: string }>).some((row) => sameInstant(row.created_at, createdAt))
      if (equivalent) return false
    }
    this.db.prepare(`
      INSERT INTO customer_deposit_transactions (
        id, tenant_id, customer_id, amount, balance_after, method, order_id,
        sale_id, shift_id, notes, created_by, remote_updated_at,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        customer_id = excluded.customer_id,
        amount = excluded.amount,
        balance_after = excluded.balance_after,
        method = excluded.method,
        order_id = excluded.order_id,
        sale_id = excluded.sale_id,
        shift_id = excluded.shift_id,
        notes = excluded.notes,
        created_by = excluded.created_by,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE customer_deposit_transactions.dirty_at IS NULL
    `).run(
      id, tenantId, transaction.customer_id, Math.round(asNumber(transaction.amount)),
      Math.round(asNumber(transaction.balance_after)), method, orderId, saleId, shiftId,
      transaction.notes ?? null, transaction.created_by ?? null, createdAt, createdAt, createdAt,
    )
    return true
  }

  private upsertSalaryPayment(tenantId: string, payment: any, importedAt: string): boolean {
    const id = asText(payment?.id)
    if (!id || this.isDirty('salary_payments', tenantId, id)) return false
    if (!this.exists('staff_users', tenantId, payment.employee_id)) return false
    const createdAt = asTimestamp(payment.created_at, importedAt)
    const workDate = asText(payment.work_date) ?? createdAt.slice(0, 10)
    const period = asText(payment.period) ?? workDate.slice(0, 7)
    const shiftId = payment.shift_id && this.exists('shifts', tenantId, payment.shift_id)
      ? payment.shift_id
      : null
    const cashOperationId = payment.cash_operation_id && this.exists('cash_operations', tenantId, payment.cash_operation_id)
      ? payment.cash_operation_id
      : null
    const saleId = payment.commission_source_sale_id && this.exists('sales', tenantId, payment.commission_source_sale_id)
      ? payment.commission_source_sale_id
      : null
    const orderId = payment.commission_source_order_id && this.exists('customer_orders', tenantId, payment.commission_source_order_id)
      ? payment.commission_source_order_id
      : null
    const type = ['salary', 'bonus', 'advance', 'penalty'].includes(String(payment.type))
      ? String(payment.type)
      : 'salary'
    const method = ['cash', 'card', 'transfer'].includes(String(payment.method))
      ? String(payment.method)
      : 'cash'
    this.db.prepare(`
      INSERT INTO salary_payments (
        id, tenant_id, employee_id, employee_name, amount, type, method, period,
        work_date, source, note, shift_id, cash_operation_id,
        commission_source_sale_id, commission_source_order_id, created_by,
        remote_updated_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        employee_id = excluded.employee_id,
        employee_name = excluded.employee_name,
        amount = excluded.amount,
        type = excluded.type,
        method = excluded.method,
        period = excluded.period,
        work_date = excluded.work_date,
        source = excluded.source,
        note = excluded.note,
        shift_id = excluded.shift_id,
        cash_operation_id = excluded.cash_operation_id,
        commission_source_sale_id = excluded.commission_source_sale_id,
        commission_source_order_id = excluded.commission_source_order_id,
        created_by = excluded.created_by,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE salary_payments.dirty_at IS NULL
    `).run(
      id, tenantId, payment.employee_id, payment.employee_name ?? payment.employee_id,
      Math.round(asNumber(payment.amount)), type, method, period, workDate,
      payment.source ?? 'manual', payment.note ?? null, shiftId, cashOperationId,
      saleId, orderId, payment.created_by ?? null, createdAt, createdAt, createdAt,
    )
    if (cashOperationId) {
      this.db.prepare(`
        UPDATE cash_operations
        SET type = 'salary_payout', employee_id = ?
        WHERE id = ? AND tenant_id = ? AND dirty_at IS NULL AND deleted_at IS NULL
      `).run(payment.employee_id, cashOperationId, tenantId)
    }
    return true
  }
}
