import type { LocalDatabase } from '../db/localDatabase'
import type { LocalBootstrapImportResult, LocalBootstrapSnapshot, LocalSyncPullChanges, LocalSyncPullResult } from '../db/localTypes'
import { normalizeSearchText } from './catalogRepository'
import { LocalSecondarySyncImporter } from './secondarySyncImporter'
import { LocalSupplierCatalogRepository } from './supplierCatalogRepository'
import { MAX_OUTBOX_ATTEMPTS } from './outboxPolicy'
import {
  mergePulledShopSettingsPreservingPending,
  parseStoredSettings,
} from './settingsMerge'

function nowIso(): string {
  return new Date().toISOString()
}

function boolInt(value: unknown, defaultValue = false): number {
  if (value === undefined || value === null) return defaultValue ? 1 : 0
  return value === true || value === 1 ? 1 : 0
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const trimmed = String(value).trim()
  return trimmed ? trimmed : null
}

function json(value: unknown, fallback: unknown): string {
  return JSON.stringify(value ?? fallback)
}

function timestamp(row: any, fallback: string): string {
  return row?.updated_at ?? row?.created_at ?? fallback
}

export class LocalBootstrapRepository {
  constructor(private readonly db: LocalDatabase) {}

  applySyncChanges(tenantId: string, changes: LocalSyncPullChanges): LocalSyncPullResult {
    const appliedAt = nowIso()
    const counts = {
      staff: 0,
      staff_pins: 0,
      products: 0,
      deleted_products: 0,
      customers: 0,
      deleted_customers: 0,
      suppliers: 0,
      deleted_suppliers: 0,
      product_barcodes: 0,
      product_aliases: 0,
      product_cross_numbers: 0,
      customer_vehicles: 0,
      customer_orders: 0,
      deleted_customer_orders: 0,
      customer_order_items: 0,
      order_payments: 0,
      shifts: 0,
      sales: 0,
      sale_items: 0,
      supply_invoices: 0,
      deleted_supply_invoices: 0,
      supply_invoice_items: 0,
      supplier_payments: 0,
      categories: 0,
      brands: 0,
      inventory_sessions: 0,
      deleted_inventory_sessions: 0,
      inventory_items: 0,
      supplier_price_items: 0,
      supplier_price_imports: 0,
      deleted_staff: 0,
      deleted_categories: 0,
      deleted_brands: 0,
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
      settings: 0,
    }

    this.db.transaction(() => {
      if (changes.shop_settings) {
        this.upsertSettings(changes.shop_settings, appliedAt)
        counts.settings++
      }

      for (const user of changes.staff ?? []) {
        this.upsertStaff(tenantId, user, appliedAt)
        counts.staff++
      }

      if (changes.references_included) {
        this.replaceTenantTable('product_barcodes', tenantId)
        this.replaceTenantTable('product_aliases', tenantId)
        this.replaceTenantTable('product_cross_numbers', tenantId)
        this.replaceTenantTable('customer_vehicles', tenantId)
      }

      for (const brand of changes.brands ?? []) {
        this.upsertBrand(tenantId, brand, appliedAt)
        counts.brands++
      }

      for (const category of changes.categories ?? []) {
        this.upsertCategoryShell(tenantId, category, appliedAt)
        counts.categories++
      }
      for (const category of changes.categories ?? []) {
        this.updateCategoryParent(tenantId, category, appliedAt)
      }

      for (const product of changes.products ?? []) {
        if (product.brand?.id && product.brand?.name) this.upsertBrand(tenantId, product.brand, appliedAt)
        if (product.category?.id && product.category?.name) {
          this.upsertCategoryShell(tenantId, product.category, appliedAt)
          this.updateCategoryParent(tenantId, product.category, appliedAt)
        }
        this.upsertProduct(tenantId, product, appliedAt)
        counts.products++
      }

      for (const productId of changes.deleted_product_ids ?? []) {
        this.markDeleted('products', tenantId, productId, appliedAt)
        counts.deleted_products++
      }

      for (const barcode of changes.product_barcodes ?? []) {
        if (!this.refExists('products', tenantId, barcode.product_id)) continue
        this.upsertProductBarcode(tenantId, barcode, appliedAt)
        counts.product_barcodes++
      }

      for (const alias of changes.product_aliases ?? []) {
        if (!this.refExists('products', tenantId, alias.product_id)) continue
        this.upsertProductAlias(tenantId, alias, appliedAt)
        counts.product_aliases++
      }

      for (const cross of changes.product_cross_numbers ?? []) {
        if (!this.refExists('products', tenantId, cross.product_id)) continue
        this.upsertProductCrossNumber(tenantId, cross, appliedAt)
        counts.product_cross_numbers++
      }

      for (const customer of changes.customers ?? []) {
        this.upsertCustomer(tenantId, customer, appliedAt)
        counts.customers++
      }

      for (const customerId of changes.deleted_customer_ids ?? []) {
        this.markDeleted('customers', tenantId, customerId, appliedAt)
        counts.deleted_customers++
      }

      for (const supplier of changes.suppliers ?? []) {
        this.upsertSupplier(tenantId, supplier, appliedAt)
        counts.suppliers++
      }

      for (const supplierId of changes.deleted_supplier_ids ?? []) {
        this.markDeleted('suppliers', tenantId, supplierId, appliedAt)
        counts.deleted_suppliers++
      }

      for (const shift of changes.shifts ?? []) {
        this.upsertShift(tenantId, shift, appliedAt)
        counts.shifts++
      }

      for (const sale of changes.sales ?? []) {
        this.upsertSale(tenantId, sale, appliedAt)
        counts.sales++
      }

      for (const item of changes.sale_items ?? []) {
        this.upsertSaleItem(tenantId, item, appliedAt)
        counts.sale_items++
      }

      for (const order of changes.customer_orders ?? []) {
        this.upsertCustomerOrder(tenantId, order, appliedAt)
        counts.customer_orders++
      }

      for (const orderId of changes.deleted_customer_order_ids ?? []) {
        this.markDeleted('customer_orders', tenantId, orderId, appliedAt)
        counts.deleted_customer_orders++
      }

      // Сервер повертає повний актуальний список позицій для кожного зміненого
      // замовлення. Видаляємо лише відсутні на сервері чисті рядки: так рядки,
      // у яких касиру замасковано buy_price, зберігають вже відому собівартість.
      const remoteItemIdsByOrder = new Map<string, string[]>()
      for (const item of changes.customer_order_items ?? []) {
        if (!item?.order_id || !item?.id) continue
        const ids = remoteItemIdsByOrder.get(item.order_id) ?? []
        ids.push(item.id)
        remoteItemIdsByOrder.set(item.order_id, ids)
      }
      for (const order of changes.customer_orders ?? []) {
        const localOrder = this.db.prepare(`
          SELECT dirty_at FROM customer_orders WHERE id = ? AND tenant_id = ? LIMIT 1
        `).get(order.id, tenantId) as { dirty_at: string | null } | undefined
        if (localOrder?.dirty_at) continue
        const remoteItemIds = remoteItemIdsByOrder.get(order.id) ?? []
        if (remoteItemIds.length === 0) {
          this.db.prepare(`
            DELETE FROM customer_order_items
            WHERE order_id = ? AND tenant_id = ? AND dirty_at IS NULL
          `).run(order.id, tenantId)
          continue
        }
        const placeholders = remoteItemIds.map(() => '?').join(', ')
        this.db.prepare(`
          DELETE FROM customer_order_items
          WHERE order_id = ? AND tenant_id = ? AND dirty_at IS NULL
            AND id NOT IN (${placeholders})
        `).run(order.id, tenantId, ...remoteItemIds)
      }

      for (const item of changes.customer_order_items ?? []) {
        if (!this.refExists('customer_orders', tenantId, item.order_id)) continue
        this.upsertCustomerOrderItem(tenantId, item, appliedAt)
        counts.customer_order_items++
      }

      for (const payment of changes.order_payments ?? []) {
        if (!this.refExists('customer_orders', tenantId, payment.order_id)) continue
        this.upsertOrderPayment(tenantId, payment, appliedAt)
        counts.order_payments++
      }
      for (const invoice of changes.supply_invoices ?? []) {
        this.upsertSupplyInvoice(tenantId, invoice, appliedAt)
        counts.supply_invoices++
      }

      for (const invoiceId of changes.deleted_supply_invoice_ids ?? []) {
        this.markDeleted('supply_invoices', tenantId, invoiceId, appliedAt)
        counts.deleted_supply_invoices++
      }

      // Для кожної зміненої накладної сервер повертає повний актуальний список
      // рядків. Прибираємо відсутні чисті рядки, але не чіпаємо локальні правки,
      // які ще очікують відправлення в outbox.
      const remoteSupplyItemIdsByInvoice = new Map<string, string[]>()
      for (const item of changes.supply_invoice_items ?? []) {
        if (!item?.invoice_id || !item?.id) continue
        const ids = remoteSupplyItemIdsByInvoice.get(item.invoice_id) ?? []
        ids.push(item.id)
        remoteSupplyItemIdsByInvoice.set(item.invoice_id, ids)
      }
      for (const invoice of changes.supply_invoices ?? []) {
        const localInvoice = this.db.prepare(`
          SELECT dirty_at FROM supply_invoices WHERE id = ? AND tenant_id = ? LIMIT 1
        `).get(invoice.id, tenantId) as { dirty_at: string | null } | undefined
        if (localInvoice?.dirty_at) continue
        const remoteItemIds = remoteSupplyItemIdsByInvoice.get(invoice.id) ?? []
        if (remoteItemIds.length === 0) {
          this.db.prepare(`
            DELETE FROM supply_invoice_items
            WHERE invoice_id = ? AND tenant_id = ? AND dirty_at IS NULL
          `).run(invoice.id, tenantId)
          continue
        }
        const placeholders = remoteItemIds.map(() => '?').join(', ')
        this.db.prepare(`
          DELETE FROM supply_invoice_items
          WHERE invoice_id = ? AND tenant_id = ? AND dirty_at IS NULL
            AND id NOT IN (${placeholders})
        `).run(invoice.id, tenantId, ...remoteItemIds)
      }

      for (const item of changes.supply_invoice_items ?? []) {
        if (!this.refExists('supply_invoices', tenantId, item.invoice_id)) continue
        if (!this.refExists('products', tenantId, item.product_id)) continue
        this.upsertSupplyInvoiceItem(tenantId, item, appliedAt)
        counts.supply_invoice_items++
      }

      for (const payment of changes.supplier_payments ?? []) {
        if (!this.refExists('supply_invoices', tenantId, payment.invoice_id)) continue
        this.upsertSupplierPayment(tenantId, payment, appliedAt)
        counts.supplier_payments++
      }

      for (const vehicle of changes.customer_vehicles ?? []) {
        if (!this.refExists('customers', tenantId, vehicle.customer_id)) continue
        this.upsertCustomerVehicle(tenantId, vehicle, appliedAt)
        counts.customer_vehicles++
      }

      for (const session of changes.inventory_sessions ?? []) {
        this.upsertInventorySession(tenantId, session, appliedAt)
        counts.inventory_sessions++
      }

      for (const item of changes.inventory_items ?? []) {
        if (!this.refExists('inventory_sessions', tenantId, item.session_id)) continue
        if (!this.refExists('products', tenantId, item.product_id)) continue
        this.upsertInventoryItem(tenantId, item, appliedAt)
        counts.inventory_items++
      }
      for (const sessionId of changes.deleted_inventory_session_ids ?? []) {
        if (this.deleteInventorySessionFromRemote(tenantId, sessionId)) counts.deleted_inventory_sessions++
      }

      const supplierCatalog = new LocalSupplierCatalogRepository(this.db)
      for (const item of changes.supplier_price_items ?? []) {
        if (supplierCatalog.upsertRemoteItem(item, tenantId, appliedAt)) counts.supplier_price_items++
      }
      for (const record of changes.supplier_price_imports ?? []) {
        if (supplierCatalog.upsertRemoteImport(record, tenantId, appliedAt)) counts.supplier_price_imports++
      }
      const secondaryCounts = new LocalSecondarySyncImporter(this.db).apply(tenantId, changes, appliedAt, {
        catalogStructure: changes.catalog_structure_snapshot_included === true,
        staff: changes.staff_snapshot_included === true,
        commissionRules: changes.commission_rules_snapshot_included === true,
        salaryPayments: changes.salary_payments_snapshot_included === true,
        stockReserves: changes.stock_reserves_snapshot_included === true,
      })
      Object.assign(counts, secondaryCounts)
    })

    return { applied_at: appliedAt, cursor: changes.cursor, counts }
  }

  importSnapshot(snapshot: LocalBootstrapSnapshot): LocalBootstrapImportResult {
    const importedAt = nowIso()
    const cursor = snapshot.exported_at || importedAt
    const tenantId = snapshot.tenant_id
    const counts = {
      staff: 0,
      staff_pins: 0,
      categories: 0,
      brands: 0,
      suppliers: 0,
      products: 0,
      product_barcodes: 0,
      product_aliases: 0,
      product_cross_numbers: 0,
      customers: 0,
      customer_vehicles: 0,
      customer_orders: 0,
      deleted_customer_orders: 0,
      customer_order_items: 0,
      order_payments: 0,
      shifts: 0,
      sales: 0,
      sale_items: 0,
      supply_invoices: 0,
      deleted_supply_invoices: 0,
      supply_invoice_items: 0,
      supplier_payments: 0,
      inventory_sessions: 0,
      deleted_inventory_sessions: 0,
      inventory_items: 0,
      supplier_price_items: 0,
      supplier_price_imports: 0,
      deleted_staff: 0,
      deleted_categories: 0,
      deleted_brands: 0,
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
      settings: 0,
    }

    this.db.transaction(() => {
      if (snapshot.shop_settings) {
        this.upsertSettings(snapshot.shop_settings, importedAt)
        counts.settings++
      }

      for (const user of snapshot.staff ?? []) {
        this.upsertStaff(tenantId, user, importedAt)
        counts.staff++
      }

      for (const brand of snapshot.brands ?? []) {
        this.upsertBrand(tenantId, brand, importedAt)
        counts.brands++
      }

      for (const category of snapshot.categories ?? []) {
        this.upsertCategoryShell(tenantId, category, importedAt)
        counts.categories++
      }
      for (const category of snapshot.categories ?? []) {
        this.updateCategoryParent(tenantId, category, importedAt)
      }

      for (const supplier of snapshot.suppliers ?? []) {
        this.upsertSupplier(tenantId, supplier, importedAt)
        counts.suppliers++
      }

      for (const product of snapshot.products ?? []) {
        this.upsertProduct(tenantId, product, importedAt)
        counts.products++
      }

      for (const barcode of snapshot.product_barcodes ?? []) {
        this.upsertProductBarcode(tenantId, barcode, importedAt)
        counts.product_barcodes++
      }

      for (const alias of snapshot.product_aliases ?? []) {
        this.upsertProductAlias(tenantId, alias, importedAt)
        counts.product_aliases++
      }

      for (const cross of snapshot.product_cross_numbers ?? []) {
        this.upsertProductCrossNumber(tenantId, cross, importedAt)
        counts.product_cross_numbers++
      }

      for (const customer of snapshot.customers ?? []) {
        this.upsertCustomer(tenantId, customer, importedAt)
        counts.customers++
      }

      for (const vehicle of snapshot.customer_vehicles ?? []) {
        this.upsertCustomerVehicle(tenantId, vehicle, importedAt)
        counts.customer_vehicles++
      }

      for (const shift of snapshot.shifts ?? []) {
        this.upsertShift(tenantId, shift, importedAt)
        counts.shifts++
      }

      for (const sale of snapshot.sales ?? []) {
        this.upsertSale(tenantId, sale, importedAt)
        counts.sales++
      }

      for (const item of snapshot.sale_items ?? []) {
        this.upsertSaleItem(tenantId, item, importedAt)
        counts.sale_items++
      }

      for (const order of snapshot.customer_orders ?? []) {
        this.upsertCustomerOrder(tenantId, order, importedAt)
        counts.customer_orders++
      }

      for (const item of snapshot.customer_order_items ?? []) {
        if (!this.refExists('customer_orders', tenantId, item.order_id)) continue
        this.upsertCustomerOrderItem(tenantId, item, importedAt)
        counts.customer_order_items++
      }

      for (const payment of snapshot.order_payments ?? []) {
        if (!this.refExists('customer_orders', tenantId, payment.order_id)) continue
        this.upsertOrderPayment(tenantId, payment, importedAt)
        counts.order_payments++
      }
      for (const invoice of snapshot.supply_invoices ?? []) {
        this.upsertSupplyInvoice(tenantId, invoice, importedAt)
        counts.supply_invoices++
      }

      for (const item of snapshot.supply_invoice_items ?? []) {
        if (!this.refExists('supply_invoices', tenantId, item.invoice_id)) continue
        if (!this.refExists('products', tenantId, item.product_id)) continue
        this.upsertSupplyInvoiceItem(tenantId, item, importedAt)
        counts.supply_invoice_items++
      }

      for (const payment of snapshot.supplier_payments ?? []) {
        if (!this.refExists('supply_invoices', tenantId, payment.invoice_id)) continue
        this.upsertSupplierPayment(tenantId, payment, importedAt)
        counts.supplier_payments++
      }

      for (const session of snapshot.inventory_sessions ?? []) {
        this.upsertInventorySession(tenantId, session, importedAt)
        counts.inventory_sessions++
      }

      for (const item of snapshot.inventory_items ?? []) {
        if (!this.refExists('inventory_sessions', tenantId, item.session_id)) continue
        if (!this.refExists('products', tenantId, item.product_id)) continue
        this.upsertInventoryItem(tenantId, item, importedAt)
        counts.inventory_items++
      }
      for (const sessionId of snapshot.deleted_inventory_session_ids ?? []) {
        if (this.deleteInventorySessionFromRemote(tenantId, sessionId)) counts.deleted_inventory_sessions++
      }

      const supplierCatalog = new LocalSupplierCatalogRepository(this.db)
      for (const item of snapshot.supplier_price_items ?? []) {
        if (supplierCatalog.upsertRemoteItem(item, tenantId, importedAt)) counts.supplier_price_items++
      }
      for (const record of snapshot.supplier_price_imports ?? []) {
        if (supplierCatalog.upsertRemoteImport(record, tenantId, importedAt)) counts.supplier_price_imports++
      }
      const secondaryCounts = new LocalSecondarySyncImporter(this.db).apply(tenantId, snapshot, importedAt, {
        catalogStructure: true,
        staff: true,
        commissionRules: true,
        salaryPayments: true,
        stockReserves: true,
      })
      Object.assign(counts, secondaryCounts)

      this.db.prepare(`
        INSERT INTO app_meta(key, value_json, updated_at)
        VALUES ('last_bootstrap_snapshot', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(json({ exported_at: snapshot.exported_at, counts }, {}), importedAt)

      this.db.prepare(`
        INSERT INTO sync_state(scope, pull_cursor, last_attempt_at, last_success_at, last_error, updated_at)
        VALUES ('desktop_server_pull', ?, ?, ?, NULL, ?)
        ON CONFLICT(scope) DO UPDATE SET
          pull_cursor = excluded.pull_cursor,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(cursor, importedAt, importedAt, importedAt)

      this.db.prepare(`
        INSERT INTO app_meta(key, value_json, updated_at)
        VALUES ('desktop_last_reference_sync_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(JSON.stringify(importedAt), importedAt)
    })

    return { imported_at: importedAt, tenant_id: tenantId, counts }
  }

  private upsertSettings(settings: any, importedAt: string): void {
    const pendingLocalSettings = this.db.prepare(`
      SELECT payload_json FROM sync_outbox
      WHERE aggregate_type = 'settings'
        AND aggregate_id = 'shop'
        AND operation_type = 'settings.updated'
        AND (
          status = 'pending'
          OR (status = 'failed' AND attempts < ${MAX_OUTBOX_ATTEMPTS})
        )
      ORDER BY sequence ASC
    `).all() as Array<{ payload_json: string | null }>

    const stored = this.db.prepare("SELECT value_json FROM app_meta WHERE key = 'shop_settings'")
      .get() as { value_json: string } | undefined
    const safeSettings = mergePulledShopSettingsPreservingPending(
      parseStoredSettings(stored?.value_json),
      settings,
      pendingLocalSettings.map((row) => row.payload_json),
    )
    this.db.prepare(`
      INSERT INTO app_meta(key, value_json, updated_at)
      VALUES ('shop_settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(safeSettings), importedAt)
  }

  private upsertStaff(tenantId: string, user: any, importedAt: string): void {
    const updatedAt = timestamp(user, importedAt)
    const baseRate = Math.max(0, Math.round(Number(user.base_rate ?? 0) || 0))
    const ratePeriod = user.rate_period === 'month' ? 'month' : 'day'
    this.db.prepare(`
      INSERT INTO staff_users (
        id, tenant_id, full_name, role, phone, is_active, base_rate, rate_period,
        remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        full_name = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.full_name ELSE staff_users.full_name END,
        role = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.role ELSE staff_users.role END,
        phone = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.phone ELSE staff_users.phone END,
        is_active = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.is_active ELSE staff_users.is_active END,
        base_rate = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.base_rate ELSE staff_users.base_rate END,
        rate_period = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.rate_period ELSE staff_users.rate_period END,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.updated_at ELSE staff_users.updated_at END,
        deleted_at = CASE WHEN staff_users.dirty_at IS NULL THEN excluded.deleted_at ELSE staff_users.deleted_at END
    `).run(
      user.id,
      tenantId,
      user.full_name || user.email || user.phone || user.id,
      user.role ?? 'cashier',
      text(user.phone),
      boolInt(user.is_active, true),
      baseRate,
      ratePeriod,
      updatedAt,
      user.created_at ?? updatedAt,
      updatedAt,
      user.deleted_at ?? null,
    )
  }
  private upsertBrand(tenantId: string, brand: any, importedAt: string): void {
    const updatedAt = timestamp(brand, importedAt)
    if (this.shouldKeepLocalCatalogDelete('brands', 'brand', tenantId, brand.id, importedAt, brand.deleted_at ?? null)) return
    this.db.prepare(`
      INSERT INTO brands (id, tenant_id, name, country, remote_updated_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        country = excluded.country,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE brands.dirty_at IS NULL
    `).run(
      brand.id,
      tenantId,
      brand.name,
      text(brand.country),
      updatedAt,
      brand.created_at ?? updatedAt,
      updatedAt,
      brand.deleted_at ?? null,
    )
  }

  private upsertCategoryShell(tenantId: string, category: any, importedAt: string): void {
    const updatedAt = timestamp(category, importedAt)
    if (this.shouldKeepLocalCatalogDelete('categories', 'category', tenantId, category.id, importedAt, category.deleted_at ?? null)) return
    const pendingDelete = this.db.prepare(`
      SELECT 1 FROM sync_outbox
      WHERE tenant_id = ?
        AND aggregate_type = 'category'
        AND aggregate_id = ?
        AND operation_type = 'category.deleted'
        AND status <> 'synced'
      LIMIT 1
    `).get(tenantId, category.id) as { 1: number } | undefined
    if (pendingDelete && !category.deleted_at) {
      this.db.prepare(`
        UPDATE categories
        SET deleted_at = COALESCE(deleted_at, dirty_at, updated_at, ?), updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(importedAt, importedAt, category.id, tenantId)
      return
    }
    const existing = this.db.prepare(`
      SELECT deleted_at FROM categories WHERE id = ? AND tenant_id = ? LIMIT 1
    `).get(category.id, tenantId) as { deleted_at: string | null } | undefined
    if (existing?.deleted_at && !category.deleted_at) {
      // Локальне видалення має пріоритет над старим серверним snapshot,
      // інакше категорії «воскресають» після перезапуску/перезбірки.
      return
    }
    this.db.prepare(`
      INSERT INTO categories (id, tenant_id, parent_id, name, sort_order, remote_updated_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE categories.dirty_at IS NULL
    `).run(
      category.id,
      tenantId,
      category.name,
      category.sort_order ?? 0,
      updatedAt,
      category.created_at ?? updatedAt,
      updatedAt,
      category.deleted_at ?? null,
    )
  }

  private shouldKeepLocalCatalogDelete(
    table: 'products' | 'brands' | 'categories',
    aggregateType: 'product' | 'brand' | 'category',
    tenantId: string,
    id: string,
    importedAt: string,
    incomingDeletedAt: string | null | undefined,
  ): boolean {
    if (!id || incomingDeletedAt) return false

    const pendingDelete = this.db.prepare(`
      SELECT 1 FROM sync_outbox
      WHERE tenant_id = ?
        AND aggregate_type = ?
        AND aggregate_id = ?
        AND operation_type = ?
        AND status <> 'synced'
      LIMIT 1
    `).get(tenantId, aggregateType, id, `${aggregateType}.deleted`) as Record<string, unknown> | undefined

    const existing = this.db.prepare(`
      SELECT deleted_at FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1
    `).get(id, tenantId) as { deleted_at: string | null } | undefined

    if (pendingDelete && !existing?.deleted_at) {
      this.db.prepare(`
        UPDATE ${table}
        SET deleted_at = COALESCE(deleted_at, dirty_at, updated_at, ?), updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(importedAt, importedAt, id, tenantId)
    }

    return Boolean(existing?.deleted_at || pendingDelete)
  }
  private updateCategoryParent(tenantId: string, category: any, importedAt: string): void {
    this.db.prepare(`
      UPDATE categories
      SET parent_id = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND dirty_at IS NULL
    `).run(category.parent_id ?? null, timestamp(category, importedAt), category.id, tenantId)
  }

  private upsertSupplier(tenantId: string, supplier: any, importedAt: string): void {
    const updatedAt = timestamp(supplier, importedAt)
    this.db.prepare(`
      INSERT INTO suppliers (
        id, tenant_id, name, phone, email, contact_name, notes, is_active,
        remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        phone = excluded.phone,
        email = excluded.email,
        contact_name = excluded.contact_name,
        notes = excluded.notes,
        is_active = excluded.is_active,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE suppliers.dirty_at IS NULL
    `).run(
      supplier.id,
      tenantId,
      supplier.name,
      text(supplier.phone),
      text(supplier.email),
      text(supplier.contact_name),
      supplier.notes ?? null,
      boolInt(supplier.is_active, true),
      updatedAt,
      supplier.created_at ?? updatedAt,
      updatedAt,
      supplier.deleted_at ?? null,
    )
  }

  private upsertProduct(tenantId: string, product: any, importedAt: string): void {
    const updatedAt = timestamp(product, importedAt)
    const hasPurchasePrice = Object.prototype.hasOwnProperty.call(product, 'purchase_price')
    const hasCoreReturn = Object.prototype.hasOwnProperty.call(product, 'requires_core_return')
    const hasCoreDeposit = Object.prototype.hasOwnProperty.call(product, 'core_deposit_amount')
    if (this.shouldKeepLocalCatalogDelete('products', 'product', tenantId, product.id, importedAt, product.deleted_at ?? null)) return
    const incomingBrandId = product.brand_id ?? product.brand?.id
    const incomingCategoryId = product.category_id ?? product.category?.id
    const brandId = incomingBrandId && this.refExists('brands', tenantId, incomingBrandId)
      ? incomingBrandId
      : null
    const categoryId = incomingCategoryId && this.refExists('categories', tenantId, incomingCategoryId)
      ? incomingCategoryId
      : null
    const searchText = normalizeSearchText([
      product.sku,
      product.name,
      product.barcode,
      product.storage_bin,
    ].filter(Boolean).join(' '))

    this.db.prepare(`
      INSERT INTO products (
        id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
        purchase_price, retail_price, qty_on_hand, reorder_point, notes,
        is_active, is_service, storage_bin, is_favorite, photo_url, specs_json,
        requires_core_return, core_deposit_amount, search_text, remote_updated_at,
        created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sku = excluded.sku,
        name = excluded.name,
        barcode = excluded.barcode,
        brand_id = excluded.brand_id,
        category_id = excluded.category_id,
        unit = excluded.unit,
        purchase_price = CASE WHEN ? THEN excluded.purchase_price ELSE products.purchase_price END,
        retail_price = excluded.retail_price,
        qty_on_hand = excluded.qty_on_hand,
        reorder_point = excluded.reorder_point,
        notes = excluded.notes,
        is_active = excluded.is_active,
        is_service = excluded.is_service,
        storage_bin = excluded.storage_bin,
        is_favorite = excluded.is_favorite,
        photo_url = CASE
          WHEN products.photo_url LIKE 'file:%' AND products.photo_url != COALESCE(excluded.photo_url, '')
            THEN products.photo_url
          ELSE excluded.photo_url
        END,
        specs_json = excluded.specs_json,
        requires_core_return = CASE WHEN ? THEN excluded.requires_core_return ELSE products.requires_core_return END,
        core_deposit_amount = CASE WHEN ? THEN excluded.core_deposit_amount ELSE products.core_deposit_amount END,
        search_text = excluded.search_text,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE products.dirty_at IS NULL
    `).run(
      product.id,
      tenantId,
      product.sku,
      product.name,
      text(product.barcode),
      brandId,
      categoryId,
      product.unit ?? 'шт',
      product.purchase_price ?? 0,
      product.retail_price ?? 0,
      product.qty_on_hand ?? 0,
      product.reorder_point ?? 0,
      product.notes ?? null,
      boolInt(product.is_active, true),
      boolInt(product.is_service, false),
      text(product.storage_bin),
      boolInt(product.is_favorite, false),
      text(product.photo_url),
      json(product.specs, {}),
      boolInt(product.requires_core_return, false),
      product.core_deposit_amount ?? 0,
      searchText,
      updatedAt,
      product.created_at ?? updatedAt,
      updatedAt,
      product.deleted_at ?? null,
      hasPurchasePrice ? 1 : 0,
      hasCoreReturn ? 1 : 0,
      hasCoreDeposit ? 1 : 0,
    )
  }

  private upsertProductBarcode(tenantId: string, barcode: any, importedAt: string): void {
    const updatedAt = timestamp(barcode, importedAt)
    this.db.prepare(`
      INSERT INTO product_barcodes (
        id, tenant_id, product_id, barcode, barcode_type, is_primary,
        created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, barcode) DO UPDATE SET
        product_id = excluded.product_id,
        barcode_type = excluded.barcode_type,
        is_primary = excluded.is_primary,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      barcode.id,
      tenantId,
      barcode.product_id,
      barcode.barcode,
      barcode.barcode_type ?? 'ean13',
      boolInt(barcode.is_primary, false),
      barcode.created_at ?? updatedAt,
      updatedAt,
      barcode.deleted_at ?? null,
    )
  }

  private upsertProductAlias(tenantId: string, alias: any, importedAt: string): void {
    const updatedAt = timestamp(alias, importedAt)
    this.db.prepare(`
      INSERT INTO product_aliases (id, tenant_id, product_id, alias, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id,
        alias = excluded.alias,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      alias.id,
      tenantId,
      alias.product_id,
      alias.alias,
      alias.created_at ?? updatedAt,
      updatedAt,
      alias.deleted_at ?? null,
    )
  }

  private upsertProductCrossNumber(tenantId: string, cross: any, importedAt: string): void {
    const updatedAt = timestamp(cross, importedAt)
    this.db.prepare(`
      INSERT INTO product_cross_numbers (
        id, tenant_id, product_id, cross_number, brand, source, notes,
        created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id,
        cross_number = excluded.cross_number,
        brand = excluded.brand,
        source = excluded.source,
        notes = excluded.notes,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      cross.id,
      tenantId,
      cross.product_id,
      cross.number ?? cross.cross_number,
      text(cross.brand),
      cross.source ?? 'manual',
      cross.number_type ?? null,
      cross.created_at ?? updatedAt,
      updatedAt,
      cross.deleted_at ?? null,
    )
  }

  private upsertCustomer(tenantId: string, customer: any, importedAt: string): void {
    const updatedAt = timestamp(customer, importedAt)
    this.db.prepare(`
      INSERT INTO customers (
        id, tenant_id, phone, full_name, email, birth_date, debt_balance, deposit_balance, loyalty_mode, notes, tags_json,
        price_tier_id, bonus_balance, vip_level, risk_profile, discount_pct,
        client_status, card_barcode, remote_updated_at, created_at, updated_at,
        deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phone = excluded.phone,
        full_name = excluded.full_name,
        email = excluded.email,
        birth_date = excluded.birth_date,
        debt_balance = excluded.debt_balance,
        deposit_balance = excluded.deposit_balance,
        loyalty_mode = excluded.loyalty_mode,
        notes = excluded.notes,
        tags_json = excluded.tags_json,
        price_tier_id = excluded.price_tier_id,
        bonus_balance = excluded.bonus_balance,
        vip_level = excluded.vip_level,
        risk_profile = excluded.risk_profile,
        discount_pct = excluded.discount_pct,
        client_status = excluded.client_status,
        card_barcode = excluded.card_barcode,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE customers.dirty_at IS NULL
    `).run(
      customer.id,
      tenantId,
      text(customer.phone),
      text(customer.full_name),
      text(customer.email),
      customer.birth_date ?? null,
      customer.debt_balance ?? 0,
      customer.deposit_balance ?? 0,
      customer.loyalty_mode ?? 'discount',
      customer.notes ?? null,
      json(customer.tags, []),
      customer.price_tier_id ?? null,
      customer.bonus_balance ?? 0,
      customer.vip_level ?? 'standard',
      customer.risk_profile ?? 'low',
      customer.discount_pct ?? 0,
      customer.client_status ?? 'client',
      text(customer.card_barcode),
      updatedAt,
      customer.created_at ?? updatedAt,
      updatedAt,
      customer.deleted_at ?? null,
    )
  }

  private upsertCustomerVehicle(tenantId: string, vehicle: any, importedAt: string): void {
    const updatedAt = timestamp(vehicle, importedAt)
    this.db.prepare(`
      INSERT INTO customer_vehicles (
        id, tenant_id, customer_id, brand, model, year, vin, notes,
        remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        customer_id = excluded.customer_id,
        brand = excluded.brand,
        model = excluded.model,
        year = excluded.year,
        vin = excluded.vin,
        notes = excluded.notes,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE customer_vehicles.dirty_at IS NULL
    `).run(
      vehicle.id,
      tenantId,
      vehicle.customer_id,
      vehicle.brand ?? vehicle.make ?? '',
      vehicle.model ?? '',
      vehicle.year ?? null,
      text(vehicle.vin),
      vehicle.notes ?? null,
      updatedAt,
      vehicle.created_at ?? updatedAt,
      updatedAt,
      vehicle.deleted_at ?? null,
    )
  }

  private upsertCustomerOrder(tenantId: string, order: any, importedAt: string): void {
    const updatedAt = timestamp(order, importedAt)
    const saleId = order.sale_id && this.refExists('sales', tenantId, order.sale_id)
      ? order.sale_id
      : null
    this.db.prepare(`
      INSERT INTO customer_orders (
        id, tenant_id, order_number, kp_number, customer_id, chat_id, manager_id,
        vehicle_info_json, status, prepayment, prepayment_method, prepayment_is_fiscal,
        total_amount, total_paid, discount_amount, pickup_deadline_at, pickup_cell,
        comment, source, sale_id, sent_to_telegram_at, remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        order_number = excluded.order_number,
        kp_number = excluded.kp_number,
        customer_id = excluded.customer_id,
        chat_id = excluded.chat_id,
        manager_id = excluded.manager_id,
        vehicle_info_json = excluded.vehicle_info_json,
        status = excluded.status,
        prepayment = excluded.prepayment,
        prepayment_method = excluded.prepayment_method,
        prepayment_is_fiscal = excluded.prepayment_is_fiscal,
        total_amount = excluded.total_amount,
        total_paid = excluded.total_paid,
        discount_amount = excluded.discount_amount,
        pickup_deadline_at = excluded.pickup_deadline_at,
        pickup_cell = excluded.pickup_cell,
        comment = excluded.comment,
        source = excluded.source,
        sale_id = excluded.sale_id,
        sent_to_telegram_at = excluded.sent_to_telegram_at,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE customer_orders.dirty_at IS NULL
    `).run(
      order.id,
      tenantId,
      order.order_number ?? null,
      text(order.kp_number),
      order.customer_id ?? order.customer?.id ?? null,
      order.chat_id ?? null,
      order.manager_id ?? null,
      json(order.vehicle_info, null),
      order.status ?? 'lead',
      order.prepayment ?? 0,
      order.prepayment_method ?? null,
      boolInt(order.prepayment_is_fiscal, false),
      order.total_amount ?? 0,
      order.total_paid ?? order.prepayment ?? 0,
      order.discount_amount ?? 0,
      order.pickup_deadline_at ?? null,
      order.pickup_cell ?? null,
      order.comment ?? null,
      order.source ?? 'walk_in',
      saleId,
      order.sent_to_telegram_at ?? null,
      updatedAt,
      order.created_at ?? updatedAt,
      updatedAt,
      order.deleted_at ?? null,
    )
  }

  private upsertCustomerOrderItem(tenantId: string, item: any, importedAt: string): void {
    const updatedAt = timestamp(item, importedAt)
    const hasBuyPrice = Object.prototype.hasOwnProperty.call(item, 'buy_price')
    this.db.prepare(`
      INSERT INTO customer_order_items (
        id, tenant_id, order_id, name, sku, product_id, supplier_id, source_type,
        item_type, item_status, buy_price, sell_price, qty, expected_date,
        core_deposit_amount, core_return_status, remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        sku = excluded.sku,
        product_id = excluded.product_id,
        supplier_id = excluded.supplier_id,
        source_type = excluded.source_type,
        item_type = excluded.item_type,
        item_status = excluded.item_status,
        buy_price = CASE WHEN ? = 1 THEN excluded.buy_price ELSE customer_order_items.buy_price END,
        sell_price = excluded.sell_price,
        qty = excluded.qty,
        expected_date = excluded.expected_date,
        core_deposit_amount = excluded.core_deposit_amount,
        core_return_status = excluded.core_return_status,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE customer_order_items.dirty_at IS NULL
    `).run(
      item.id,
      tenantId,
      item.order_id,
      item.name ?? 'Товар',
      text(item.sku),
      item.product_id ?? null,
      item.supplier_id ?? null,
      item.source_type ?? 'warehouse',
      item.item_type ?? 'product',
      item.item_status ?? 'pending',
      item.buy_price ?? 0,
      item.sell_price ?? 0,
      item.qty ?? 1,
      item.expected_date ?? null,
      item.core_deposit_amount ?? 0,
      item.core_return_status ?? null,
      updatedAt,
      item.created_at ?? updatedAt,
      updatedAt,
      item.deleted_at ?? null,
      hasBuyPrice ? 1 : 0,
    )
  }

  private upsertOrderPayment(tenantId: string, payment: any, importedAt: string): void {
    const updatedAt = timestamp(payment, importedAt)
    this.db.prepare(`
      INSERT INTO order_payments (
        id, tenant_id, order_id, amount, method, is_fiscal, shift_id, created_by,
        notes, remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        amount = excluded.amount,
        method = excluded.method,
        is_fiscal = excluded.is_fiscal,
        shift_id = excluded.shift_id,
        created_by = excluded.created_by,
        notes = excluded.notes,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE order_payments.dirty_at IS NULL
    `).run(
      payment.id,
      tenantId,
      payment.order_id,
      payment.amount ?? 0,
      payment.method ?? 'cash',
      boolInt(payment.is_fiscal, false),
      payment.shift_id ?? null,
      payment.created_by ?? null,
      payment.notes ?? null,
      updatedAt,
      payment.created_at ?? updatedAt,
      updatedAt,
      payment.deleted_at ?? null,
    )
  }

  private upsertShift(tenantId: string, shift: any, importedAt: string): void {
    const updatedAt = shift.updated_at ?? shift.closed_at ?? shift.opened_at ?? shift.created_at ?? importedAt
    this.db.prepare(`
      INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash, closing_cash, expected_cash,
        cash_variance, opened_at, closed_at, notes, remote_updated_at,
        created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cashier_id = excluded.cashier_id,
        status = excluded.status,
        opening_cash = excluded.opening_cash,
        closing_cash = excluded.closing_cash,
        expected_cash = excluded.expected_cash,
        cash_variance = excluded.cash_variance,
        opened_at = excluded.opened_at,
        closed_at = excluded.closed_at,
        notes = excluded.notes,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE shifts.dirty_at IS NULL
    `).run(
      shift.id,
      tenantId,
      shift.cashier_id,
      shift.status ?? (shift.closed_at ? 'closed' : 'open'),
      shift.opening_cash ?? 0,
      shift.closing_cash ?? null,
      shift.expected_cash ?? null,
      shift.cash_variance ?? null,
      shift.opened_at ?? shift.created_at ?? updatedAt,
      shift.closed_at ?? null,
      shift.notes ?? null,
      updatedAt,
      shift.created_at ?? shift.opened_at ?? updatedAt,
      updatedAt,
      shift.deleted_at ?? null,
    )
  }

  private upsertSale(tenantId: string, sale: any, importedAt: string): void {
    if (!sale?.id || !sale.shift_id || !this.refExists('shifts', tenantId, sale.shift_id)) return
    const updatedAt = timestamp(sale, sale.completed_at ?? importedAt)
    const customerId = sale.customer_id && this.refExists('customers', tenantId, sale.customer_id)
      ? sale.customer_id
      : null
    const paymentMethod = ['cash', 'card', 'debt', 'mixed', 'transfer'].includes(String(sale.payment_method))
      ? String(sale.payment_method)
      : 'cash'
    const total = sale.total ?? 0
    this.db.prepare(`
      INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
        status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
        fiscal_number, fiscal_qr_url, bank_auth_code, terminal_rrn,
        cash_amount, card_amount, transfer_amount, debt_amount, pickup_cell, notes,
        remote_updated_at, completed_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sale_number = excluded.sale_number,
        customer_id = excluded.customer_id,
        cashier_id = excluded.cashier_id,
        manager_id = excluded.manager_id,
        shift_id = excluded.shift_id,
        status = excluded.status,
        subtotal = excluded.subtotal,
        discount = excluded.discount,
        total = excluded.total,
        payment_method = excluded.payment_method,
        is_debt = excluded.is_debt,
        is_fiscal = excluded.is_fiscal,
        fiscal_number = excluded.fiscal_number,
        fiscal_qr_url = excluded.fiscal_qr_url,
        bank_auth_code = excluded.bank_auth_code,
        terminal_rrn = excluded.terminal_rrn,
        cash_amount = excluded.cash_amount,
        card_amount = excluded.card_amount,
        transfer_amount = excluded.transfer_amount,
        debt_amount = excluded.debt_amount,
        pickup_cell = excluded.pickup_cell,
        notes = excluded.notes,
        remote_updated_at = excluded.remote_updated_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE sales.dirty_at IS NULL
    `).run(
      sale.id,
      tenantId,
      sale.sale_number ?? String(sale.id).slice(0, 8),
      customerId,
      sale.cashier_id ?? 'remote',
      sale.manager_id ?? null,
      sale.shift_id,
      sale.status ?? 'completed',
      sale.subtotal ?? total,
      sale.discount ?? 0,
      total,
      paymentMethod,
      boolInt(sale.is_debt, paymentMethod === 'debt'),
      boolInt(sale.is_fiscal, false),
      text(sale.fiscal_number),
      text(sale.fiscal_qr_url),
      text(sale.bank_auth_code),
      text(sale.terminal_rrn),
      sale.cash_amount ?? 0,
      sale.card_amount ?? 0,
      sale.transfer_amount ?? (paymentMethod === 'transfer' ? total : 0),
      sale.debt_amount ?? (paymentMethod === 'debt' ? total : 0),
      text(sale.pickup_cell),
      sale.notes ?? null,
      updatedAt,
      sale.completed_at ?? sale.created_at ?? updatedAt,
      sale.created_at ?? sale.completed_at ?? updatedAt,
      updatedAt,
      sale.deleted_at ?? null,
    )
  }

  private upsertSaleItem(tenantId: string, item: any, importedAt: string): void {
    const sale = this.db.prepare(`
      SELECT dirty_at FROM sales
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(item.sale_id, tenantId) as { dirty_at: string | null } | undefined
    if (!sale || sale.dirty_at) return
    const product = this.db.prepare(`
      SELECT id, sku, name FROM products
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(item.product_id, tenantId) as { id: string; sku: string; name: string } | undefined
    if (!product) return
    const updatedAt = timestamp(item, importedAt)
    const hasPurchasePrice = Object.prototype.hasOwnProperty.call(item, 'purchase_price')
      || Object.prototype.hasOwnProperty.call(item, 'cost_price')
    this.db.prepare(`
      INSERT INTO sale_items (
        id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
        purchase_price, discount, total, core_deposit_amount, core_return_status,
        created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sale_id = excluded.sale_id,
        product_id = excluded.product_id,
        description = excluded.description,
        sku = excluded.sku,
        qty = excluded.qty,
        unit_price = excluded.unit_price,
        purchase_price = CASE WHEN ? = 1 THEN excluded.purchase_price ELSE sale_items.purchase_price END,
        discount = excluded.discount,
        total = excluded.total,
        core_deposit_amount = excluded.core_deposit_amount,
        core_return_status = excluded.core_return_status,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      item.id,
      tenantId,
      item.sale_id,
      product.id,
      item.description ?? item.product?.name ?? product.name,
      item.sku ?? item.product?.sku ?? product.sku,
      item.qty ?? 0,
      item.unit_price ?? 0,
      item.purchase_price ?? item.cost_price ?? 0,
      item.discount ?? 0,
      item.total ?? Math.round(Number(item.qty ?? 0) * Number(item.unit_price ?? 0)),
      item.core_deposit_amount ?? 0,
      item.core_return_status ?? 'none',
      item.created_at ?? updatedAt,
      updatedAt,
      item.deleted_at ?? null,
      hasPurchasePrice ? 1 : 0,
    )
  }

  private upsertSupplyInvoice(tenantId: string, invoice: any, importedAt: string): void {
    const updatedAt = timestamp(invoice, importedAt)
    this.db.prepare(`
      INSERT INTO supply_invoices (
        id, tenant_id, supplier_id, invoice_number, status, total, paid_amount,
        payment_method, notes, posted_by, posted_at, remote_updated_at, created_at,
        updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        supplier_id = excluded.supplier_id,
        invoice_number = excluded.invoice_number,
        status = excluded.status,
        total = excluded.total,
        paid_amount = excluded.paid_amount,
        payment_method = excluded.payment_method,
        notes = excluded.notes,
        posted_by = excluded.posted_by,
        posted_at = excluded.posted_at,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE supply_invoices.dirty_at IS NULL
    `).run(
      invoice.id,
      tenantId,
      invoice.supplier_id ?? invoice.supplier?.id ?? null,
      text(invoice.invoice_number),
      invoice.status ?? 'draft',
      invoice.total ?? 0,
      invoice.paid_amount ?? 0,
      invoice.payment_method ?? null,
      invoice.notes ?? null,
      invoice.posted_by ?? null,
      invoice.posted_at ?? null,
      updatedAt,
      invoice.created_at ?? updatedAt,
      updatedAt,
      invoice.deleted_at ?? null,
    )
  }

  private upsertSupplyInvoiceItem(tenantId: string, item: any, importedAt: string): void {
    const updatedAt = timestamp(item, importedAt)
    this.db.prepare(`
      INSERT INTO supply_invoice_items (
        id, tenant_id, invoice_id, product_id, qty, purchase_price, total,
        remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        invoice_id = excluded.invoice_id,
        product_id = excluded.product_id,
        qty = excluded.qty,
        purchase_price = excluded.purchase_price,
        total = excluded.total,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE supply_invoice_items.dirty_at IS NULL
    `).run(
      item.id,
      tenantId,
      item.invoice_id,
      item.product_id,
      item.qty ?? 0,
      item.purchase_price ?? 0,
      item.total ?? 0,
      updatedAt,
      item.created_at ?? updatedAt,
      updatedAt,
      item.deleted_at ?? null,
    )
  }

  private upsertSupplierPayment(tenantId: string, payment: any, importedAt: string): void {
    const updatedAt = timestamp(payment, importedAt)
    this.db.prepare(`
      INSERT INTO supplier_payments (
        id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source,
        shift_id, note, created_by, remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        invoice_id = excluded.invoice_id,
        supplier_id = excluded.supplier_id,
        amount = excluded.amount,
        payment_method = excluded.payment_method,
        fund_source = excluded.fund_source,
        shift_id = excluded.shift_id,
        note = excluded.note,
        created_by = excluded.created_by,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE supplier_payments.dirty_at IS NULL
    `).run(
      payment.id,
      tenantId,
      payment.invoice_id,
      payment.supplier_id ?? null,
      payment.amount ?? 0,
      payment.payment_method ?? 'cash',
      payment.fund_source ?? 'cashbox',
      payment.shift_id ?? null,
      payment.note ?? null,
      payment.created_by ?? null,
      updatedAt,
      payment.created_at ?? updatedAt,
      updatedAt,
      payment.deleted_at ?? null,
    )
  }

  private deleteInventorySessionFromRemote(tenantId: string, sessionId: unknown): boolean {
    const id = text(sessionId)
    if (!id) return false
    this.db.prepare(`
      DELETE FROM sync_outbox
      WHERE tenant_id = ? AND aggregate_type = 'inventory_session' AND aggregate_id = ?
        AND status IN ('pending', 'failed', 'sending')
    `).run(tenantId, id)
    this.db.prepare('DELETE FROM inventory_count_entries WHERE tenant_id = ? AND session_id = ?').run(tenantId, id)
    this.db.prepare('DELETE FROM inventory_items WHERE tenant_id = ? AND session_id = ?').run(tenantId, id)
    const result = this.db.prepare('DELETE FROM inventory_sessions WHERE tenant_id = ? AND id = ?').run(tenantId, id)
    return Number(result.changes) > 0
  }
  private upsertInventorySession(tenantId: string, session: any, importedAt: string): void {
    const updatedAt = timestamp(session, importedAt)
    this.db.prepare(`
      INSERT INTO inventory_sessions (
        id, tenant_id, session_name, status, started_by, started_at, completed_at,
        remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_name = excluded.session_name,
        status = excluded.status,
        started_by = COALESCE(inventory_sessions.started_by, excluded.started_by),
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
      WHERE inventory_sessions.dirty_at IS NULL
    `).run(
      session.id,
      tenantId,
      session.name ?? session.session_name ?? 'Ревізія',
      session.status ?? 'completed',
      session.started_by ?? session.created_by ?? null,
      session.started_at ?? session.created_at ?? updatedAt,
      session.completed_at ?? null,
      updatedAt,
      session.created_at ?? updatedAt,
      updatedAt,
      session.deleted_at ?? null,
    )
  }

  private upsertInventoryItem(tenantId: string, item: any, importedAt: string): void {
    const updatedAt = timestamp(item, importedAt)
    this.db.prepare(`
      INSERT INTO inventory_items (
        id, tenant_id, session_id, product_id, expected_stock, counted_stock, was_counted,
        price_checked, observed_retail_price, last_counted_by, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, product_id) DO UPDATE SET
        expected_stock = excluded.expected_stock,
        counted_stock = excluded.counted_stock,
        was_counted = excluded.was_counted,
        price_checked = excluded.price_checked,
        observed_retail_price = excluded.observed_retail_price,
        last_counted_by = excluded.last_counted_by,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      item.id,
      tenantId,
      item.session_id,
      item.product_id,
      item.expected_stock ?? 0,
      item.counted_stock ?? 0,
      boolInt(item.was_counted, true),
      boolInt(item.price_checked, true),
      item.observed_retail_price ?? null,
      item.last_counted_by ?? null,
      item.created_at ?? updatedAt,
      updatedAt,
      item.deleted_at ?? null,
    )
  }
  private markDeleted(table: 'products' | 'customers' | 'suppliers' | 'customer_orders' | 'supply_invoices', tenantId: string, id: string, deletedAt: string): void {
    this.db.prepare(`
      UPDATE ${table}
      SET deleted_at = ?,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND dirty_at IS NULL
    `).run(deletedAt, deletedAt, id, tenantId)
  }

  private replaceTenantTable(
    table: 'product_barcodes' | 'product_aliases' | 'product_cross_numbers' | 'customer_vehicles',
    tenantId: string,
  ): void {
    if (table === 'customer_vehicles') {
      this.db.prepare('DELETE FROM customer_vehicles WHERE tenant_id = ? AND dirty_at IS NULL').run(tenantId)
      return
    }
    this.db.prepare(`
      DELETE FROM ${table}
      WHERE tenant_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM products p
          WHERE p.id = ${table}.product_id
            AND p.tenant_id = ?
            AND p.dirty_at IS NOT NULL
        )
    `).run(tenantId, tenantId)
  }

  private refExists(table: 'brands' | 'categories' | 'products' | 'customers' | 'customer_orders' | 'supply_invoices' | 'inventory_sessions' | 'sales' | 'shifts', tenantId: string, id: string): boolean {
    const row = this.db.prepare(`
      SELECT id
      FROM ${table}
      WHERE id = ?
        AND tenant_id = ?
        AND deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId)
    return Boolean(row)
  }
}
