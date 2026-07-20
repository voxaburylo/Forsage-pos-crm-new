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
    this.db.prepare(`
      INSERT INTO staff_users (
        id, tenant_id, full_name, role, phone, is_active, remote_updated_at,
        created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        full_name = excluded.full_name,
        role = excluded.role,
        phone = excluded.phone,
        is_active = excluded.is_active,
        remote_updated_at = excluded.remote_updated_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      user.id,
      tenantId,
      user.full_name || user.email || user.phone || user.id,
      user.role ?? 'cashier',
      text(user.phone),
      boolInt(user.is_active, true),
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
        id, tenant_id, phone, full_name, email, debt_balance, notes, tags_json,
        price_tier_id, bonus_balance, vip_level, risk_profile, discount_pct,
        client_status, card_barcode, remote_updated_at, created_at, updated_at,
        deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phone = excluded.phone,
        full_name = excluded.full_name,
        email = excluded.email,
        debt_balance = excluded.debt_balance,
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

  private markDeleted(table: 'products' | 'customers' | 'suppliers', tenantId: string, id: string, deletedAt: string): void {
    const dirtyGuard = table === 'products' ? ' AND dirty_at IS NULL' : ''
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

  private refExists(table: 'brands' | 'categories' | 'products' | 'customers', tenantId: string, id: string): boolean {
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
