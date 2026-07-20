import type { LocalDatabase } from '../db/localDatabase'
import type { LocalBootstrapImportResult, LocalBootstrapSnapshot, LocalSyncPullChanges, LocalSyncPullResult } from '../db/localTypes'
import { normalizeSearchText } from './catalogRepository'

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
      supply_invoices: 0,
      deleted_supply_invoices: 0,
      supply_invoice_items: 0,
      supplier_payments: 0,
      categories: 0,
      brands: 0,
    }

    this.db.transaction(() => {
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

      for (const order of changes.customer_orders ?? []) {
        this.upsertCustomerOrder(tenantId, order, appliedAt)
        counts.customer_orders++
      }

      for (const orderId of changes.deleted_customer_order_ids ?? []) {
        this.markDeleted('customer_orders', tenantId, orderId, appliedAt)
        counts.deleted_customer_orders++
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
    })

    return { applied_at: appliedAt, cursor: changes.cursor, counts }
  }

  importSnapshot(snapshot: LocalBootstrapSnapshot): LocalBootstrapImportResult {
    const importedAt = nowIso()
    const cursor = snapshot.exported_at || importedAt
    const tenantId = snapshot.tenant_id
    const counts = {
      staff: 0,
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
      supply_invoices: 0,
      deleted_supply_invoices: 0,
      supply_invoice_items: 0,
      supplier_payments: 0,
    }

    this.db.transaction(() => {
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
    this.db.prepare(`
      INSERT INTO brands (id, tenant_id, name, country, remote_updated_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        country = excluded.country,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
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
    this.db.prepare(`
      INSERT INTO categories (id, tenant_id, parent_id, name, sort_order, remote_updated_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
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

  private updateCategoryParent(tenantId: string, category: any, importedAt: string): void {
    this.db.prepare(`
      UPDATE categories
      SET parent_id = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
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
        purchase_price = excluded.purchase_price,
        retail_price = excluded.retail_price,
        qty_on_hand = excluded.qty_on_hand,
        reorder_point = excluded.reorder_point,
        notes = excluded.notes,
        is_active = excluded.is_active,
        is_service = excluded.is_service,
        storage_bin = excluded.storage_bin,
        is_favorite = excluded.is_favorite,
        photo_url = excluded.photo_url,
        specs_json = excluded.specs_json,
        requires_core_return = excluded.requires_core_return,
        core_deposit_amount = excluded.core_deposit_amount,
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
        id, tenant_id, phone, full_name, email, debt_balance, deposit_balance, loyalty_mode, notes, tags_json,
        price_tier_id, bonus_balance, vip_level, risk_profile, discount_pct,
        client_status, card_barcode, remote_updated_at, created_at, updated_at,
        deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phone = excluded.phone,
        full_name = excluded.full_name,
        email = excluded.email,
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
    `).run(
      customer.id,
      tenantId,
      text(customer.phone),
      text(customer.full_name),
      text(customer.email),
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
    this.db.prepare(`
      INSERT INTO customer_orders (
        id, tenant_id, order_number, kp_number, customer_id, chat_id, manager_id,
        vehicle_info_json, status, prepayment, prepayment_method, prepayment_is_fiscal,
        total_amount, total_paid, discount_amount, pickup_deadline_at, pickup_cell,
        comment, source, sent_to_telegram_at, remote_updated_at, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      order.sent_to_telegram_at ?? null,
      updatedAt,
      order.created_at ?? updatedAt,
      updatedAt,
      order.deleted_at ?? null,
    )
  }

  private upsertCustomerOrderItem(tenantId: string, item: any, importedAt: string): void {
    const updatedAt = timestamp(item, importedAt)
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
        buy_price = excluded.buy_price,
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
  private markDeleted(table: 'products' | 'customers' | 'suppliers' | 'customer_orders' | 'supply_invoices', tenantId: string, id: string, deletedAt: string): void {
    const dirtyGuard = table === 'products' || table === 'customer_orders' || table === 'supply_invoices' ? ' AND dirty_at IS NULL' : ''
    this.db.prepare(`
      UPDATE ${table}
      SET deleted_at = ?,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?${dirtyGuard}
    `).run(deletedAt, deletedAt, id, tenantId)
  }

  private replaceTenantTable(
    table: 'product_barcodes' | 'product_aliases' | 'product_cross_numbers' | 'customer_vehicles',
    tenantId: string,
  ): void {
    this.db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId)
  }

  private refExists(table: 'brands' | 'categories' | 'products' | 'customers' | 'customer_orders' | 'supply_invoices', tenantId: string, id: string): boolean {
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
