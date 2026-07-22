import { randomUUID } from 'node:crypto'
import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { listUsers } from './adminService.js'

const PAGE_SIZE = 1000
const CURSOR_OVERLAP_MS = 5_000

async function fetchAll(buildQuery: (from: number, to: number) => any): Promise<any[]> {
  const rows: any[] = []
  let from = 0

  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    from += PAGE_SIZE
  }
}

function withChangedSince(query: any, since?: string): any {
  if (!since) return query
  return query.or(`updated_at.gt.${since},deleted_at.gt.${since}`)
}

const SHOP_SETTINGS_SYNC_KEYS = [
  'shop_name', 'shop_address', 'phone', 'max_discount_pct', 'allow_negative_qty',
  'return_days', 'default_debt_limit_kopecks', 'label_settings', 'pos_quick_items',
  'markup_rules', 'price_rounding_enabled', 'price_rounding_step', 'price_rounding_dir',
  'quick_percents', 'employee_discount_pct', 'vin_decoder_url', 'vin_decoder_api_key',
  'auto_print_receipt', 'receipt_width_mm', 'owner_telegram_chat_id',
] as const

function sanitizeShopSettings(row: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!row) return null
  const { ai_api_key_encrypted: _omit, ...safe } = row
  return safe
}

function pickShopSettingsPayload(payload: Record<string, any> | null | undefined): Record<string, any> {
  const updates: Record<string, any> = {}
  if (!payload || typeof payload !== 'object') return updates
  for (const key of SHOP_SETTINGS_SYNC_KEYS) {
    if (payload[key] !== undefined) updates[key] = payload[key]
  }
  return updates
}

async function fetchShopSettings(tenantId: string): Promise<Record<string, any> | null> {
  const { data, error } = await db
    .from('shop_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return sanitizeShopSettings(data as Record<string, any> | null)
}

async function loadAvailability(productIds: string[]): Promise<Map<string, { qty_reserved: number; qty_available: number }>> {
  const result = new Map<string, { qty_reserved: number; qty_available: number }>()
  for (let start = 0; start < productIds.length; start += PAGE_SIZE) {
    const ids = productIds.slice(start, start + PAGE_SIZE)
    if (ids.length === 0) continue
    const { data, error } = await db
      .from('products_available')
      .select('product_id,qty_reserved,qty_available')
      .in('product_id', ids)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    for (const row of data ?? []) {
      result.set(row.product_id, {
        qty_reserved: Number(row.qty_reserved ?? 0),
        qty_available: Number(row.qty_available ?? 0),
      })
    }
  }
  return result
}

export interface SyncChangesInput {
  since?: string
  tenantId: string
  role: string
  includeReferences?: boolean
}

export interface SyncOutboxOperation {
  sequence: number
  operation_id: string
  tenant_id: string
  device_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload: any
  created_at: string
}

export interface SyncPushResult {
  sequence: number
  operation_id: string
  status: 'synced' | 'failed'
  aggregate_id?: string
  error?: string
}

/**
 * One consistent local-first pull endpoint.
 *
 * The cursor intentionally trails the request by five seconds. Duplicate rows
 * are harmless IndexedDB upserts, while a gap during concurrent writes could
 * permanently lose a stock/customer update.
 */
export async function getSyncChanges({
  since,
  tenantId,
  role,
  includeReferences = false,
}: SyncChangesInput) {
  const nextCursor = new Date(Date.now() - CURSOR_OVERLAP_MS).toISOString()
  const referencesIncluded = !since || includeReferences

  const [
    productRows,
    customerRows,
    supplierRows,
    sales,
    categories,
    brands,
    productBarcodes,
    productAliases,
    productCrossNumbers,
    customerVehicles,
    customerOrders,
    customerOrderItems,
    orderPayments,
    supplyInvoices,
    supplyInvoiceItems,
    supplierPayments,
    inventorySessions,
    inventoryItems,
    shopSettings,
  ] = await Promise.all([
    fetchAll((from, to) => {
      let query = db
        .from('products')
        .select('*,brand:brands(id,name),category:categories(id,name)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      query = withChangedSince(query, since)
      if (!since) query = query.is('deleted_at', null)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('customers')
        .select('*,price_tier:price_tiers(id,name,discount_pct),customer_cars(vin)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      query = withChangedSince(query, since)
      if (!since) query = query.is('deleted_at', null)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('suppliers')
        .select('id,tenant_id,name,phone,email,contact_name,notes,is_active,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      query = withChangedSince(query, since)
      if (!since) query = query.is('deleted_at', null)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('sales')
        .select('*,sale_items(*,product:products(id,sku,name,unit)),customer:customers(id,phone,full_name)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      if (since) query = query.gt('updated_at', since)
      return query.range(from, to)
    }),
    referencesIncluded
      ? fetchAll((from, to) => db
          .from('categories')
          .select('id,parent_id,name,sort_order,created_at')
          .eq('tenant_id', tenantId)
          .order('sort_order', { ascending: true })
          .range(from, to))
      : Promise.resolve([]),
    referencesIncluded
      ? fetchAll((from, to) => db
          .from('brands')
          .select('id,name,country,created_at')
          .eq('tenant_id', tenantId)
          .order('name', { ascending: true })
          .range(from, to))
      : Promise.resolve([]),
    referencesIncluded
      ? fetchAll((from, to) => db
          .from('product_barcodes')
          .select('id,tenant_id,product_id,barcode,barcode_type,is_primary,created_at')
          .eq('tenant_id', tenantId)
          .range(from, to))
      : Promise.resolve([]),
    referencesIncluded
      ? fetchAll((from, to) => db
          .from('product_aliases')
          .select('id,tenant_id,product_id,alias,created_at')
          .eq('tenant_id', tenantId)
          .range(from, to))
      : Promise.resolve([]),
    referencesIncluded
      ? fetchAll((from, to) => db
          .from('product_cross_numbers')
          .select('id,tenant_id,product_id,number,normalized_number,number_type,brand,source,is_verified,created_at')
          .eq('tenant_id', tenantId)
          .range(from, to))
      : Promise.resolve([]),
    referencesIncluded
      ? fetchAll((from, to) => db
          .from('customer_cars')
          .select('id,tenant_id,customer_id,make,model,year,vin,notes,created_at')
          .eq('tenant_id', tenantId)
          .range(from, to))
      : Promise.resolve([]),
    fetchAll((from, to) => {
      let query = db
        .from('customer_orders')
        .select('*,customer:customers(id,phone,full_name,card_barcode)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      query = withChangedSince(query, since)
      if (!since) query = query.is('deleted_at', null)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      const query = db
        .from('customer_order_items')
        .select('*,order:customer_orders!inner(tenant_id)')
        .eq('order.tenant_id', tenantId)
        .order('created_at', { ascending: true })
      if (since) query.gt('created_at', since)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('order_payments')
        .select('*,order:customer_orders!inner(tenant_id)')
        .eq('order.tenant_id', tenantId)
        .order('created_at', { ascending: true })
      if (since) query = query.gt('created_at', since)
      return query.range(from, to)
    }),    fetchAll((from, to) => {
      let query = db
        .from('supply_invoices')
        .select('*,supplier:suppliers(id,name)')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: true })
      if (since) query = query.gt('updated_at', since)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('supply_invoice_items')
        .select('*,invoice:supply_invoices!inner(tenant_id)')
        .eq('invoice.tenant_id', tenantId)
        .order('created_at', { ascending: true })
      if (since) query = query.gt('created_at', since)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('supplier_payments')
        .select('*,invoice:supply_invoices!inner(tenant_id)')
        .eq('invoice.tenant_id', tenantId)
        .order('created_at', { ascending: true })
      if (since) query = query.gt('created_at', since)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('inventory_sessions')
        .select('id,tenant_id,name,status,created_by,started_by,started_at,completed_at,created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true })
      if (since && !referencesIncluded) query = query.or(`completed_at.gt.${since},started_at.gt.${since},created_at.gt.${since}`)
      return query.range(from, to)
    }),
    fetchAll((from, to) => {
      let query = db
        .from('inventory_items')
        .select('id,session_id,product_id,expected_stock,counted_stock,was_counted,price_checked,observed_retail_price,last_counted_by,created_at,updated_at,product:products!inner(tenant_id)')
        .eq('product.tenant_id', tenantId)
        .gt('counted_stock', 0)
        .order('updated_at', { ascending: true })
      if (since && !referencesIncluded) query = query.gt('updated_at', since)
      return query.range(from, to)
    }),
    fetchShopSettings(tenantId),
  ])

  const deletedProductIds = productRows.filter((row) => row.deleted_at).map((row) => row.id)
  const activeProducts = productRows.filter((row) => !row.deleted_at)
  const availability = await loadAvailability(activeProducts.map((row) => row.id))
  const products = activeProducts.map((product) => {
    const available = availability.get(product.id)
    const result = {
      ...product,
      qty_reserved: available?.qty_reserved ?? 0,
      qty_available: available?.qty_available ?? Number(product.qty_on_hand ?? 0),
    }
    if (role === 'cashier' || role === 'manager') {
      delete result.purchase_price
      delete result.cost_price
    }
    return result
  })

  const deletedCustomerIds = customerRows.filter((row) => row.deleted_at).map((row) => row.id)
  const customers = customerRows
    .filter((row) => !row.deleted_at)
    .map((customer) => ({
      ...customer,
      primary_vin: customer.customer_cars?.find((car: any) => car.vin)?.vin ?? null,
      car_count: Array.isArray(customer.customer_cars) ? customer.customer_cars.length : 0,
      customer_cars: undefined,
    }))

  const deletedSupplierIds = supplierRows.filter((row) => row.deleted_at).map((row) => row.id)
  const suppliers = supplierRows.filter((row) => !row.deleted_at)
  const deletedCustomerOrderIds = customerOrders.filter((row) => row.deleted_at).map((row) => row.id)
  const activeCustomerOrders = customerOrders.filter((row) => !row.deleted_at)
  const activeCustomerOrderItems = customerOrderItems
    .filter((row) => !row.deleted_at)
    .map((row) => ({ ...row, order: undefined }))
  const activeOrderPayments = orderPayments.map((row) => ({ ...row, order: undefined }))
  const activeSupplyInvoiceItems = supplyInvoiceItems.map((row) => ({ ...row, invoice: undefined }))
  const activeSupplierPayments = supplierPayments.map((row) => ({ ...row, invoice: undefined }))
  const activeInventoryItems = inventoryItems.map((row) => ({ ...row, product: undefined }))

  return {
    tenant_id: tenantId,
    cursor: nextCursor,
    products,
    deleted_product_ids: deletedProductIds,
    customers,
    deleted_customer_ids: deletedCustomerIds,
    suppliers,
    deleted_supplier_ids: deletedSupplierIds,
    sales,
    categories,
    brands,
    product_barcodes: productBarcodes,
    product_aliases: productAliases,
    product_cross_numbers: productCrossNumbers,
    customer_vehicles: customerVehicles,
    customer_orders: activeCustomerOrders,
    deleted_customer_order_ids: deletedCustomerOrderIds,
    customer_order_items: activeCustomerOrderItems,
    order_payments: activeOrderPayments,
    supply_invoices: supplyInvoices,
    deleted_supply_invoice_ids: [],
    supply_invoice_items: activeSupplyInvoiceItems,
    supplier_payments: activeSupplierPayments,
    inventory_sessions: inventorySessions,
    inventory_items: activeInventoryItems,
    shop_settings: shopSettings,
    references_included: referencesIncluded,
  }
}

export async function getBootstrapSnapshot(tenantId: string) {
  const [
    staff,
    categories,
    brands,
    suppliers,
    products,
    productBarcodes,
    productAliases,
    productCrossNumbers,
    customers,
    customerVehicles,
    customerOrders,
    customerOrderItems,
    orderPayments,
    supplyInvoices,
    supplyInvoiceItems,
    supplierPayments,
    inventorySessions,
    inventoryItems,
    shopSettings,
  ] = await Promise.all([
    listUsers(tenantId),
    fetchAll((from, to) => db
      .from('categories')
      .select('id,tenant_id,parent_id,name,sort_order,created_at')
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('brands')
      .select('id,tenant_id,name,country,created_at')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('suppliers')
      .select('id,tenant_id,name,phone,email,contact_name,notes,is_active,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('products')
      .select([
        'id', 'tenant_id', 'sku', 'name', 'barcode', 'brand_id', 'category_id',
        'unit', 'purchase_price', 'retail_price', 'qty_on_hand', 'reorder_point',
        'notes', 'is_active', 'is_service', 'storage_bin', 'is_favorite',
        'photo_url', 'specs', 'requires_core_return', 'core_deposit_amount',
        'created_at', 'updated_at', 'deleted_at',
      ].join(','))
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('product_barcodes')
      .select('id,tenant_id,product_id,barcode,barcode_type,is_primary,created_at')
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('product_aliases')
      .select('id,tenant_id,product_id,alias,created_at')
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('product_cross_numbers')
      .select('id,tenant_id,product_id,number,normalized_number,number_type,brand,source,is_verified,created_at')
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('customers')
      .select([
        'id', 'tenant_id', 'phone', 'full_name', 'email', 'debt_balance',
        'deposit_balance', 'loyalty_mode', 'notes', 'tags', 'price_tier_id', 'bonus_balance', 'vip_level',
        'risk_profile', 'discount_pct', 'client_status', 'card_barcode',
        'created_at', 'updated_at', 'deleted_at',
      ].join(','))
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('customer_cars')
      .select('id,tenant_id,customer_id,make,model,year,vin,notes,created_at')
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('customer_orders')
      .select('*,customer:customers(id,phone,full_name,card_barcode)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('customer_order_items')
      .select('*,order:customer_orders!inner(tenant_id)')
      .eq('order.tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('order_payments')
      .select('*,order:customer_orders!inner(tenant_id)')
      .eq('order.tenant_id', tenantId)
      .range(from, to)),    fetchAll((from, to) => db
      .from('supply_invoices')
      .select('*,supplier:suppliers(id,name)')
      .eq('tenant_id', tenantId)
      .range(from, to)),
    fetchAll((from, to) => db
      .from('supply_invoice_items')
      .select('*,invoice:supply_invoices!inner(tenant_id)')
      .eq('invoice.tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('supplier_payments')
      .select('*,invoice:supply_invoices!inner(tenant_id)')
      .eq('invoice.tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('inventory_sessions')
      .select('id,tenant_id,name,status,created_by,started_by,started_at,completed_at,created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .range(from, to)),
    fetchAll((from, to) => db
      .from('inventory_items')
      .select('id,session_id,product_id,expected_stock,counted_stock,was_counted,price_checked,observed_retail_price,last_counted_by,created_at,updated_at,product:products!inner(tenant_id)')
      .eq('product.tenant_id', tenantId)
      .gt('counted_stock', 0)
      .order('updated_at', { ascending: true })
      .range(from, to)),
    fetchShopSettings(tenantId),
  ])

  return {
    exported_at: new Date().toISOString(),
    tenant_id: tenantId,
    staff,
    categories,
    brands,
    suppliers,
    products,
    product_barcodes: productBarcodes,
    product_aliases: productAliases,
    product_cross_numbers: productCrossNumbers,
    customers,
    customer_vehicles: customerVehicles,
    customer_orders: customerOrders,
    customer_order_items: customerOrderItems.map((row) => ({ ...row, order: undefined })),
    order_payments: orderPayments.map((row) => ({ ...row, order: undefined })),
    supply_invoices: supplyInvoices,
    supply_invoice_items: supplyInvoiceItems.map((row) => ({ ...row, invoice: undefined })),
    supplier_payments: supplierPayments.map((row) => ({ ...row, invoice: undefined })),
    inventory_sessions: inventorySessions,
    inventory_items: inventoryItems.map((row) => ({ ...row, product: undefined })),
    shop_settings: shopSettings,
    counts: {
      staff: staff.length,
      categories: categories.length,
      brands: brands.length,
      suppliers: suppliers.length,
      products: products.length,
      product_barcodes: productBarcodes.length,
      product_aliases: productAliases.length,
      product_cross_numbers: productCrossNumbers.length,
      customers: customers.length,
      customer_vehicles: customerVehicles.length,
      customer_orders: customerOrders.length,
      customer_order_items: customerOrderItems.length,
      order_payments: orderPayments.length,
      supply_invoices: supplyInvoices.length,
      supply_invoice_items: supplyInvoiceItems.length,
      supplier_payments: supplierPayments.length,
      inventory_sessions: inventorySessions.length,
      inventory_items: inventoryItems.length,
      settings: shopSettings ? 1 : 0,
    },
  }
}

export async function pushLocalOperations(params: {
  tenantId: string
  userId: string
  operations: SyncOutboxOperation[]
}): Promise<{ results: SyncPushResult[] }> {
  const results: SyncPushResult[] = []

  for (const operation of params.operations) {
    try {
      if (operation.tenant_id !== params.tenantId) {
        throw new AppError('SYNC_TENANT_MISMATCH', 'Операція належить іншому магазину', 403)
      }

      await applyLocalOperation({
        tenantId: params.tenantId,
        userId: params.userId,
        operation,
      })

      results.push({
        sequence: operation.sequence,
        operation_id: operation.operation_id,
        aggregate_id: operation.aggregate_id,
        status: 'synced',
      })
    } catch (error: any) {
      results.push({
        sequence: operation.sequence,
        operation_id: operation.operation_id,
        aggregate_id: operation.aggregate_id,
        status: 'failed',
        error: error?.message ?? 'Помилка синхронізації',
      })
    }
  }

  return { results }
}

async function applyLocalOperation(params: {
  tenantId: string
  userId: string
  operation: SyncOutboxOperation
}): Promise<void> {
  const { operation, tenantId, userId } = params

  if (operation.operation_type === 'shift.opened') {
    await applyShiftOpened(tenantId, operation)
    return
  }

  if (operation.operation_type === 'shift.closed') {
    await applyShiftClosed(tenantId, operation)
    return
  }

  if (operation.operation_type === 'sale.completed') {
    await applySaleCompleted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'product.upsert') {
    await applyProductUpsert(tenantId, operation)
    return
  }

  if (operation.operation_type === 'product.deleted') {
    await applyProductDeleted(tenantId, operation)
    return
  }

  if (operation.operation_type === 'category.upsert') {
    await applyCategoryUpsert(tenantId, operation)
    return
  }

  if (operation.operation_type === 'category.deleted') {
    await applyCategoryDeleted(tenantId, operation)
    return
  }

  if (operation.operation_type === 'brand.upsert') {
    await applyBrandUpsert(tenantId, operation)
    return
  }

  if (operation.operation_type === 'brand.deleted') {
    await applyBrandDeleted(tenantId, operation)
    return
  }

  if (operation.operation_type === 'settings.updated') {
    await applySettingsUpdated(tenantId, operation)
    return
  }

  if (operation.operation_type === 'inventory.completed') {
    await applyInventoryCompleted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'order.payment_added') {
    await applyOrderPaymentAdded(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'order.completed') {
    await applyOrderCompleted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'customer.debt_paid') {
    await applyCustomerDebtPaid(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'customer.deposit_changed') {
    await applyCustomerDepositChanged(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'supplier_invoice.created') {
    await applySupplierInvoiceCreated(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.updated') {
    await applySupplierInvoiceUpdated(tenantId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.posted') {
    await applySupplierInvoicePosted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.payment_added') {
    await applySupplierInvoicePaymentAdded(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.cancelled') {
    await applySupplierInvoiceCancelled(tenantId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.deleted') {
    await applySupplierInvoiceDeleted(tenantId, operation)
    return
  }

  throw new AppError('SYNC_UNSUPPORTED_OPERATION', `Непідтримувана операція: ${operation.operation_type}`, 400)
}

function invoiceLineTotal(item: any): number {
  const itemQty = Number(item?.qty ?? 0)
  const purchasePrice = Number(item?.purchase_price ?? 0)
  const total = Number(item?.total ?? itemQty * purchasePrice)
  return Math.max(0, Math.round(total))
}

async function applySupplierInvoiceCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const invoiceId = String(payload.id || operation.aggregate_id)
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) throw new AppError('SYNC_INVOICE_EMPTY', 'У накладній немає товарів', 422)
  const total = items.reduce((sum: number, item: any) => sum + invoiceLineTotal(item), 0)
  const paidAmount = Math.max(0, Math.min(Number(payload.paid_amount ?? 0), total))
  const timestamp = operation.created_at || new Date().toISOString()

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM supply_invoices WHERE id = $1 AND tenant_id = $2 LIMIT 1', [invoiceId, tenantId])
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO supply_invoices (
        id, tenant_id, supplier_id, invoice_number, status, total, paid_amount,
        payment_method, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$9)`,
      [invoiceId, tenantId, payload.supplier_id ?? null, payload.invoice_number ?? null, total, paidAmount, paidAmount > 0 ? (payload.payment_method ?? 'cash') : null, payload.notes ?? null, timestamp],
    )

    for (const item of items) {
      await client.query(
        `INSERT INTO supply_invoice_items (id, tenant_id, invoice_id, product_id, qty, purchase_price, total, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [item.id ?? randomUUID(), tenantId, invoiceId, item.product_id, Number(item.qty ?? 0), Number(item.purchase_price ?? 0), invoiceLineTotal(item), timestamp],
      )
    }

    if (paidAmount > 0) {
      const paymentId = payload.payment_id ?? randomUUID()
      const method = payload.payment_method ?? 'cash'
      const fundSource = payload.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
      await client.query(
        `INSERT INTO supplier_payments
         (id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [paymentId, tenantId, invoiceId, payload.supplier_id ?? null, paidAmount, method, fundSource, payload.shift_id ?? null, 'Оплата під час створення накладної', userId, timestamp],
      )
      if (fundSource === 'cashbox') {
        await client.query(
          `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, source, created_by, created_at)
           VALUES ($1,$2,'out',$3,$4,'cashbox',$5,$6)`,
          [tenantId, payload.shift_id ?? null, paidAmount, 'Оплата постачальнику під час створення накладної', userId, timestamp],
        )
      }
    }
  })
}

async function applySupplierInvoiceUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const invoice = await client.query('SELECT status FROM supply_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [operation.aggregate_id, tenantId])
    if (!invoice.rowCount) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    if (invoice.rows[0].status !== 'draft') throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)
    await client.query(
      'UPDATE supply_invoices SET invoice_number = $1, notes = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4',
      [payload.invoice_number ?? null, payload.notes ?? null, operation.aggregate_id, tenantId],
    )
  })
}

async function applySupplierInvoicePosted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: invoice } = await db
    .from('supply_invoices')
    .select('id,status')
    .eq('id', operation.aggregate_id)
    .eq('tenant_id', tenantId)
    .single()
  if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
  if (invoice.status === 'posted') return
  const { error } = await db.rpc('post_supply_invoice', {
    p_invoice_id: operation.aggregate_id,
    p_user_id: userId,
  })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

async function applySupplierInvoicePaymentAdded(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const paymentId = String(payload.payment_id || operation.operation_id)
  const amount = Math.round(Number(payload.amount ?? 0))
  if (amount <= 0) throw new AppError('INVALID_AMOUNT', 'Сума оплати має бути більше нуля', 422)
  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM supplier_payments WHERE id = $1 LIMIT 1', [paymentId])
    if (existing.rowCount && existing.rowCount > 0) return
    const invoiceResult = await client.query(
      `SELECT id, supplier_id, total, COALESCE(paid_amount, 0) AS paid_amount
       FROM supply_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    const invoice = invoiceResult.rows[0]
    if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    const remaining = Number(invoice.total) - Number(invoice.paid_amount)
    if (amount > remaining) throw new AppError('PAYMENT_TOO_LARGE', 'Сума перевищує борг за накладною', 422)
    const method = payload.payment_method ?? 'cash'
    const fundSource = payload.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
    await client.query(
      `INSERT INTO supplier_payments
       (id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [paymentId, tenantId, operation.aggregate_id, invoice.supplier_id, amount, method, fundSource, payload.shift_id ?? null, payload.note ?? null, userId],
    )
    await client.query(
      'UPDATE supply_invoices SET paid_amount = COALESCE(paid_amount, 0) + $1, payment_method = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4',
      [amount, method, operation.aggregate_id, tenantId],
    )
    if (fundSource === 'cashbox') {
      await client.query(
        `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, created_by, source)
         VALUES ($1,$2,'out',$3,$4,$5,'cashbox')`,
        [tenantId, payload.shift_id ?? null, amount, payload.note || 'Оплата постачальнику', userId],
      )
    }
  })
}

async function applySupplierInvoiceCancelled(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: invoice } = await db
    .from('supply_invoices')
    .select('id,status')
    .eq('id', operation.aggregate_id)
    .eq('tenant_id', tenantId)
    .single()
  if (!invoice) return
  if (invoice.status === 'cancelled') return
  const { error } = await db.rpc('cancel_supply_invoice', { p_invoice_id: operation.aggregate_id })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

async function applySupplierInvoiceDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    const invoiceResult = await client.query('SELECT status FROM supply_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [operation.aggregate_id, tenantId])
    const invoice = invoiceResult.rows[0]
    if (!invoice) return
    if (invoice.status === 'posted') throw new AppError('INVOICE_POSTED', 'Не можна видалити проведену накладну', 400)
    await client.query('DELETE FROM supplier_payments WHERE invoice_id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
    await client.query('DELETE FROM supply_invoice_items WHERE invoice_id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
    await client.query('DELETE FROM supply_invoices WHERE id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
  })
}
async function applyShiftOpened(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId],
    )
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at
      )
      VALUES ($1, $2, $3, 'open', $4, $5, $6, $5)`,
      [
        operation.aggregate_id,
        tenantId,
        payload.cashier_id,
        Number(payload.opening_cash ?? 0),
        operation.created_at,
        payload.notes ?? null,
      ],
    )
  })
}

async function applyShiftClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const result = await client.query(
      `UPDATE shifts
       SET status = 'closed', closing_cash = $3, expected_cash = $4,
           cash_variance = $5, closed_at = $6, notes = COALESCE($7, notes)
       WHERE id = $1 AND tenant_id = $2`,
      [
        operation.aggregate_id,
        tenantId,
        Number(payload.closing_cash ?? 0),
        Number(payload.expected_cash ?? 0),
        Number(payload.cash_variance ?? 0),
        payload.closed_at ?? operation.created_at,
        payload.notes ?? null,
      ],
    )
    if (!result.rowCount) {
      throw new AppError('SYNC_SHIFT_NOT_FOUND', 'Зміну для закриття не знайдено', 404)
    }
  })
}

async function applySaleCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM sales WHERE id = $1 AND tenant_id = $2',
      [payload.sale_id ?? operation.aggregate_id, tenantId],
    )
    if (existing.rowCount && existing.rowCount > 0) return

    const shiftId = payload.shift_id
    const shift = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2',
      [shiftId, tenantId],
    )
    if (!shift.rowCount) {
      await client.query(
        `INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at
        )
        VALUES ($1, $2, $3, 'open', 0, $4, $5, $4)`,
        [shiftId, tenantId, payload.cashier_id ?? userId, payload.completed_at ?? operation.created_at, 'Створено під час офлайн-синхронізації'],
      )
    }

    const payments = Array.isArray(payload.payments) ? payload.payments : []
    const cashAmount = sumPayments(payments, 'cash')
    const cardAmount = sumPayments(payments, 'card')
    const paymentMethod = normalizePaymentMethod(payload.payment_method)
    const saleId = payload.sale_id ?? operation.aggregate_id
    const completedAt = payload.completed_at ?? operation.created_at
    // Старі збірки каси не клали fiscal-поля в payload — дістаємо номер з платежів
    const fiscalNumber = payload.fiscal_number
      ?? payments.find((p: { fiscal_number?: string | null }) => p?.fiscal_number)?.fiscal_number
      ?? null
    const isFiscal = payload.is_fiscal === true || fiscalNumber !== null

    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, is_fiscal, fiscal_number, fiscal_qr_url,
        completed_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'completed',
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18,
        $19, $19, $19
      )`,
      [
        saleId,
        tenantId,
        payload.sale_number,
        payload.customer_id ?? null,
        payload.cashier_id ?? userId,
        shiftId,
        Number(payload.subtotal ?? 0),
        Number(payload.discount ?? 0),
        Number(payload.total ?? 0),
        paymentMethod,
        paymentMethod === 'debt',
        payload.notes ?? null,
        payload.manager_id ?? payload.cashier_id ?? userId,
        cashAmount,
        cardAmount,
        isFiscal,
        fiscalNumber,
        payload.fiscal_qr_url ?? null,
        completedAt,
      ],
    )

    for (const item of payload.items ?? []) {
      const productId = item.product_id ?? await ensureFreeAmountProduct(client, tenantId)
      const product = await client.query(
        'SELECT id, is_service, COALESCE(purchase_price, 0) AS purchase_price FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
        [productId, tenantId],
      )
      if (!product.rowCount) {
        throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар не знайдено: ${productId}`, 404)
      }

      const qty = Number(item.qty ?? 0)
      const unitPrice = Number(item.unit_price ?? 0)
      const discount = Number(item.discount ?? 0)
      const total = Number(item.total ?? Math.max(0, qty * unitPrice - discount))
      const isService = product.rows[0].is_service === true
      const costPrice = Number(item.purchase_price ?? product.rows[0].purchase_price ?? 0)

      await client.query(
        `INSERT INTO sale_items (
          tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, saleId, productId, qty, unitPrice, discount, total, costPrice],
      )

      if (!isService) {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [qty, completedAt, productId, tenantId],
        )
      }
    }

    if (paymentMethod === 'debt' && payload.customer_id) {
      await client.query(
        'UPDATE customers SET debt_balance = debt_balance + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
        [Number(payload.total ?? 0), completedAt, payload.customer_id, tenantId],
      )
    }
  })
}

async function applySettingsUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const updates = pickShopSettingsPayload(operation.payload ?? {})
  if (Object.keys(updates).length === 0) return
  const { error } = await db
    .from('shop_settings')
    .update({ ...updates, updated_at: operation.created_at })
    .eq('tenant_id', tenantId)
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

async function applyCategoryUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const categoryId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!categoryId || !name) {
    throw new AppError('SYNC_CATEGORY_INVALID', 'Категорія має містити id і назву', 400)
  }
  const updatedAt = operation.created_at
  const sortOrder = Number(payload.sort_order ?? 0)
  const parentId = payload.parent_id ?? null

  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO categories (id, tenant_id, parent_id, name, sort_order, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, NULL)
       ON CONFLICT (id) DO UPDATE SET
         parent_id = excluded.parent_id,
         name = excluded.name,
         sort_order = excluded.sort_order,
         updated_at = excluded.updated_at,
         deleted_at = NULL
       WHERE categories.tenant_id = excluded.tenant_id`,
      [categoryId, tenantId, parentId, name, sortOrder, updatedAt],
    )
  })
}

async function applyCategoryDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const deletedAt = operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET category_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND category_id = $2 AND deleted_at IS NULL`,
      [tenantId, operation.aggregate_id, deletedAt],
    )
    await client.query(
      `UPDATE categories
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, deletedAt],
    )
  })
}

async function applyBrandUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const brandId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!brandId || !name) {
    throw new AppError('SYNC_BRAND_INVALID', 'Бренд має містити id і назву', 400)
  }
  const updatedAt = operation.created_at

  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, name, country, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $5, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         country = excluded.country,
         updated_at = excluded.updated_at,
         deleted_at = NULL
       WHERE brands.tenant_id = excluded.tenant_id`,
      [brandId, tenantId, name, payload.country ?? null, updatedAt],
    )
  })
}

async function applyBrandDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const deletedAt = operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET brand_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND brand_id = $2 AND deleted_at IS NULL`,
      [tenantId, operation.aggregate_id, deletedAt],
    )
    await client.query(
      `UPDATE brands
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, deletedAt],
    )
  })
}

async function applyProductUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const productId = String(payload.id ?? operation.aggregate_id)
  const sku = String(payload.sku ?? '').trim()
  const name = String(payload.name ?? '').trim()
  if (!productId || !sku || !name) {
    throw new AppError('SYNC_PRODUCT_INVALID', 'Товар має містити id, артикул і назву', 400)
  }
  const updatedAt = operation.created_at
  const barcodes = [...new Set([
    payload.barcode ?? null,
    ...(Array.isArray(payload.additional_barcodes) ? payload.additional_barcodes : []),
  ].filter((barcode): barcode is string => typeof barcode === 'string' && barcode.trim().length > 0))]

  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id, photo_url FROM products WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [productId, tenantId],
    )

    const requestedPhotoUrl = payload.photo_url ?? null
    const photoUrl = typeof requestedPhotoUrl === 'string' && /^file:/i.test(requestedPhotoUrl)
      ? existing.rows[0]?.photo_url ?? null
      : requestedPhotoUrl

    const values = [
      productId,
      tenantId,
      sku,
      name,
      payload.barcode ?? null,
      payload.brand_id ?? null,
      payload.category_id ?? null,
      payload.unit ?? 'шт',
      Number(payload.purchase_price ?? 0),
      Number(payload.retail_price ?? 0),
      Number(payload.qty_on_hand ?? 0),
      Number(payload.reorder_point ?? 0),
      payload.notes ?? null,
      payload.is_active === false ? false : true,
      payload.is_service === true,
      payload.storage_bin ?? null,
      payload.is_favorite === true,
      photoUrl,
      payload.specs ?? {},
      updatedAt,
    ]

    if (existing.rowCount && existing.rowCount > 0) {
      await client.query(
        `UPDATE products SET
          sku = $3, name = $4, barcode = $5, brand_id = $6, category_id = $7,
          unit = $8, purchase_price = $9, retail_price = $10, qty_on_hand = $11,
          reorder_point = $12, notes = $13, is_active = $14, is_service = $15,
          storage_bin = $16, is_favorite = $17, photo_url = $18, specs = $19,
          deleted_at = NULL, updated_at = $20
        WHERE id = $1 AND tenant_id = $2`,
        values,
      )
    } else {
      await client.query(
        `INSERT INTO products (
          id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
          purchase_price, retail_price, qty_on_hand, reorder_point, notes,
          is_active, is_service, storage_bin, is_favorite, photo_url, specs,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19,
          $20, $20
        )`,
        values,
      )
    }

    for (const barcode of barcodes) {
      const duplicateFromIndex = await client.query(
        `SELECT p.name, p.sku
         FROM product_barcodes b
         JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
         WHERE b.tenant_id = $1
           AND b.barcode = $2
           AND b.product_id <> $3
           AND p.deleted_at IS NULL
         LIMIT 1`,
        [tenantId, barcode, productId],
      )
      const duplicateFromProduct = duplicateFromIndex.rowCount && duplicateFromIndex.rowCount > 0
        ? duplicateFromIndex
        : await client.query(
          `SELECT name, sku
           FROM products
           WHERE tenant_id = $1
             AND barcode = $2
             AND deleted_at IS NULL
             AND id <> $3
           LIMIT 1`,
          [tenantId, barcode, productId],
        )
      if (duplicateFromProduct.rowCount && duplicateFromProduct.rowCount > 0) {
        const duplicate = duplicateFromProduct.rows[0]
        const label = duplicate.name || duplicate.sku || 'іншого товару'
        throw new AppError('BARCODE_TAKEN', `Штрихкод "${barcode}" вже у товару "${label}"`, 409)
      }
    }

    await client.query(
      `DELETE FROM product_barcodes
       WHERE product_id = $1
         AND tenant_id = $2
         AND NOT (barcode = ANY($3::text[]))`,
      [productId, tenantId, barcodes],
    )

    for (const barcode of barcodes) {
      await client.query(
        `INSERT INTO product_barcodes (
          id, tenant_id, product_id, barcode, barcode_type, is_primary, created_at
        ) VALUES ($1, $2, $3, $4, 'ean13', $5, $6)
        ON CONFLICT (tenant_id, barcode) DO UPDATE SET
          product_id = excluded.product_id,
          is_primary = excluded.is_primary
        WHERE product_barcodes.product_id = excluded.product_id`,
        [randomUUID(), tenantId, productId, barcode, barcode === payload.barcode, updatedAt],
      )
    }
  })
}

async function applyProductDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const deletedAt = operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET deleted_at = $3, is_active = false, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, deletedAt],
    )
    await client.query(
      `DELETE FROM product_barcodes
       WHERE product_id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId],
    )
  })
}
async function applyInventoryCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .filter((item: any) => {
      const countedStock = Number(item?.counted_stock ?? 0)
      return Boolean(item?.product_id) && Number.isFinite(countedStock) && countedStock > 0
    })
  const createdBy = payload.created_by ?? userId
  const createdAt = payload.created_at ?? operation.created_at
  const completedAt = payload.completed_at ?? operation.created_at
  const name = String(payload.name ?? `Локальна ревізія ${sessionId.slice(0, 8)}`).trim() || 'Локальна ревізія'

  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO inventory_sessions (
        id, tenant_id, name, status, created_by, started_by, started_at, completed_at, created_at
      ) VALUES (
        $1, $2, $3, 'completed', $4, $4, $5, $6, $5
      )
      ON CONFLICT (id) DO UPDATE SET
        status = 'completed',
        completed_at = EXCLUDED.completed_at`,
      [sessionId, tenantId, name, createdBy, createdAt, completedAt],
    )

    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      if (!productId) continue
      const countedStock = Number(item?.counted_stock ?? 0)
      if (!Number.isFinite(countedStock) || countedStock < 0) continue

      const product = await client.query(
        'SELECT id, COALESCE(qty_on_hand, 0) AS qty_on_hand FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
        [productId, tenantId],
      )
      if (!product.rowCount) {
        throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар ревізії не знайдено: ${productId}`, 404)
      }

      const itemResult = await client.query(
        `INSERT INTO inventory_items (
          session_id, product_id, expected_stock, counted_stock, was_counted,
          price_checked, last_counted_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, true, true, $5, $6, $6
        )
        ON CONFLICT (session_id, product_id) DO UPDATE SET
          counted_stock = EXCLUDED.counted_stock,
          was_counted = true,
          price_checked = true,
          last_counted_by = EXCLUDED.last_counted_by,
          updated_at = EXCLUDED.updated_at
        RETURNING id`,
        [sessionId, productId, Number(product.rows[0].qty_on_hand ?? 0), countedStock, createdBy, completedAt],
      )

      const inventoryItemId = itemResult.rows[0]?.id
      if (inventoryItemId) {
        await client.query(
          `INSERT INTO inventory_count_entries (
            id, tenant_id, session_id, inventory_item_id, product_id, counted_by,
            qty, price_checked, observed_retail_price, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, true, NULL, $8
          )`,
          [randomUUID(), tenantId, sessionId, inventoryItemId, productId, createdBy, countedStock, completedAt],
        )
      }

      await client.query(
        'UPDATE products SET qty_on_hand = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
        [countedStock, completedAt, productId, tenantId],
      )
    }
  })
}


async function applyCustomerDebtPaid(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' ? payload.method : 'cash'
  if (!customerId || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('SYNC_CUSTOMER_DEBT_INVALID', 'Некоректна оплата боргу', 400)
  }

  await runTransaction(async (client) => {
    const customerResult = await client.query(
      'SELECT id, full_name, phone, COALESCE(debt_balance, 0) AS debt_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    if (Number(customer.debt_balance ?? 0) <= 0) return
    const paid = Math.min(amount, Number(customer.debt_balance ?? 0))
    const balanceAfter = Number(customer.debt_balance ?? 0) - paid
    await client.query(
      'UPDATE customers SET debt_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId, balanceAfter, payload.created_at ?? operation.created_at],
    )
    if (method === 'cash' && payload.shift_id) {
      await client.query(
        `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, created_by, created_at)
         VALUES ($1, $2, 'in', $3, $4, $5, $6)`,
        [tenantId, payload.shift_id, paid, payload.notes ?? (`Оплата боргу: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`), payload.created_by ?? userId, payload.created_at ?? operation.created_at],
      )
    }
  })
}

async function applyCustomerDepositChanged(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const transactionId = String(payload.transaction_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' || payload.method === 'account' || payload.method === 'correction'
    ? payload.method
    : 'cash'
  if (!customerId || !transactionId || !Number.isFinite(amount) || amount === 0) {
    throw new AppError('SYNC_CUSTOMER_DEPOSIT_INVALID', 'Некоректний рух рахунку клієнта', 400)
  }

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM customer_deposit_transactions WHERE id = $1 LIMIT 1', [transactionId])
    if (existing.rowCount && existing.rowCount > 0) return

    const customerResult = await client.query(
      'SELECT id, full_name, phone, COALESCE(deposit_balance, 0) AS deposit_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    const balanceAfter = Number(customer.deposit_balance ?? 0) + amount
    if (balanceAfter < 0) throw new AppError('INSUFFICIENT_DEPOSIT', 'Недостатньо коштів на рахунку клієнта', 400)

    await client.query(
      'UPDATE customers SET deposit_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId, balanceAfter, payload.created_at ?? operation.created_at],
    )
    await client.query(
      `INSERT INTO customer_deposit_transactions (
        id, tenant_id, customer_id, amount, balance_after, method, order_id, sale_id,
        shift_id, notes, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [transactionId, tenantId, customerId, amount, balanceAfter, method, payload.order_id ?? null, payload.sale_id ?? null, payload.shift_id ?? null, payload.notes ?? null, payload.created_by ?? userId, payload.created_at ?? operation.created_at],
    )

    if (amount > 0 && method === 'cash' && payload.shift_id) {
      await client.query(
        `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, created_by, created_at)
         VALUES ($1, $2, 'in', $3, $4, $5, $6)`,
        [tenantId, payload.shift_id, amount, payload.notes ?? (`Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`), payload.created_by ?? userId, payload.created_at ?? operation.created_at],
      )
    }
  })
}
async function applyOrderPaymentAdded(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.order_id ?? operation.aggregate_id)
  const paymentId = String(payload.payment_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' || payload.method === 'account' ? payload.method : 'cash'
  if (!orderId || !paymentId || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('SYNC_ORDER_PAYMENT_INVALID', 'Некоректний платіж замовлення', 400)
  }

  await runTransaction(async (client) => {
    const orderResult = await client.query(
      'SELECT id, status, total_amount, discount_amount, total_paid, prepayment, customer_id, order_number FROM customer_orders WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
      [orderId, tenantId],
    )
    if (!orderResult.rowCount) throw new AppError('SYNC_ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    const order = orderResult.rows[0]
    if (order.status === 'completed') return

    const existing = await client.query('SELECT id FROM order_payments WHERE id = $1 LIMIT 1', [paymentId])
    if (existing.rowCount && existing.rowCount > 0) return

    const remaining = Number(order.total_amount ?? 0) - Number(order.discount_amount ?? 0) - Number(order.total_paid ?? order.prepayment ?? 0)
    const canAcceptOpenDraftDeposit = ['lead', 'quoted'].includes(order.status) && remaining <= 0
    if (!canAcceptOpenDraftDeposit && amount > remaining) {
      throw new AppError('SYNC_ORDER_OVERPAYMENT', 'Сума перевищує залишок до сплати', 400)
    }

    if (method === 'account') {
      if (!order.customer_id) throw new AppError('NO_CUSTOMER', 'Замовлення без клієнта — оплата з рахунку неможлива', 400)
      const transactionId = String(payload.account_transaction_id ?? paymentId)
      const existingTransaction = await client.query('SELECT id FROM customer_deposit_transactions WHERE id = $1 LIMIT 1', [transactionId])
      if (!existingTransaction.rowCount) {
        const customerResult = await client.query(
          'SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
          [order.customer_id, tenantId],
        )
        if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
        const balanceAfter = Number(customerResult.rows[0].deposit_balance ?? 0) - amount
        if (balanceAfter < 0) throw new AppError('INSUFFICIENT_DEPOSIT', 'Недостатньо коштів на рахунку клієнта', 400)
        await client.query(
          'UPDATE customers SET deposit_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
          [order.customer_id, tenantId, balanceAfter, payload.created_at ?? operation.created_at],
        )
        await client.query(
          `INSERT INTO customer_deposit_transactions (
            id, tenant_id, customer_id, amount, balance_after, method, order_id,
            notes, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, 'account', $6, $7, $8, $9)`,
          [transactionId, tenantId, order.customer_id, -amount, balanceAfter, orderId, payload.notes ?? (`Оплата замовлення #${order.order_number ?? String(orderId).slice(0, 8)}`), payload.created_by ?? userId, payload.created_at ?? operation.created_at],
        )
      }
    }

    await client.query(
      `INSERT INTO order_payments (
        id, tenant_id, order_id, amount, method, is_fiscal, shift_id, created_by, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [paymentId, tenantId, orderId, amount, method, payload.is_fiscal === true, payload.shift_id ?? null, payload.created_by ?? userId, payload.notes ?? null, payload.created_at ?? operation.created_at],
    )

    const newTotalPaid = Number(order.total_paid ?? order.prepayment ?? 0) + amount
    const updatedStatus = (order.status === 'lead' || order.status === 'quoted') && newTotalPaid > 0 ? 'new' : order.status
    await client.query(
      'UPDATE customer_orders SET total_paid = $3, status = $4, updated_at = $5 WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId, newTotalPaid, updatedStatus, payload.created_at ?? operation.created_at],
    )

    if (method === 'cash' && payload.shift_id) {
      await client.query(
        `INSERT INTO cash_operations (tenant_id, shift_id, type, amount, note, created_by, created_at)
         VALUES ($1, $2, 'in', $3, $4, $5, $6)`,
        [tenantId, payload.shift_id, amount, payload.notes ?? ('Оплата замовлення #' + (order.order_number ?? String(orderId).slice(0, 8))), payload.created_by ?? userId, payload.created_at ?? operation.created_at],
      )
    }

    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'payment_added', $3, $4)`,
      [orderId, payload.created_by ?? userId, { amount, method, offline: true }, payload.created_at ?? operation.created_at],
    )
  })
}

async function applyOrderCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.order_id ?? operation.aggregate_id)
  if (!orderId) throw new AppError('SYNC_ORDER_COMPLETE_INVALID', 'Некоректна видача замовлення', 400)

  const { data: order, error: orderError } = await db
    .from('customer_orders')
    .select('id,status,total_amount,discount_amount,total_paid,prepayment')
    .eq('id', orderId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (orderError) throw new AppError('DB_ERROR', orderError.message, 500)
  if (!order) throw new AppError('SYNC_ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
  if (order.status === 'completed') return

  const totalPaid = Number(order.total_paid ?? order.prepayment ?? 0)
  const remaining = Number(order.total_amount ?? 0) - Number(order.discount_amount ?? 0) - totalPaid
  if (remaining > 0) throw new AppError('SYNC_ORDER_INCOMPLETE_PAYMENT', 'Не всі оплати проведено', 400)

  const paymentMethod = payload.payment_method === 'card' || payload.payment_method === 'mixed' ? payload.payment_method : 'cash'
  const { error } = await db.rpc('complete_customer_order', {
    p_tenant_id: tenantId,
    p_order_id: orderId,
    p_cashier_id: payload.cashier_id ?? userId,
    p_shift_id: payload.shift_id ?? null,
    p_payment_method: paymentMethod,
    p_cash_amount: 0,
    p_card_amount: 0,
  })
  if (error) {
    if (error.message.includes('INSUFFICIENT_STOCK')) throw new AppError('INSUFFICIENT_STOCK', error.message, 422)
    throw new AppError('DB_ERROR', error.message, 500)
  }

  await db.from('order_activity_log').insert({
    order_id: orderId,
    user_id: payload.cashier_id ?? userId,
    action: 'completed',
    details: { method: paymentMethod, offline: true, shift_id: payload.shift_id ?? null },
  })
}

function normalizePaymentMethod(value: unknown): 'cash' | 'card' | 'debt' | 'mixed' | 'transfer' {
  return value === 'cash' || value === 'card' || value === 'debt' || value === 'mixed' || value === 'transfer'
    ? value
    : 'cash'
}

function sumPayments(payments: any[], method: string): number {
  return payments
    .filter((payment) => payment?.method === method)
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0)
}

async function ensureFreeAmountProduct(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>>, rowCount: number | null }> },
  tenantId: string,
): Promise<string> {
  const sku = 'LOCAL-FREE-AMOUNT'
  const existing = await client.query(
    'SELECT id FROM products WHERE tenant_id = $1 AND sku = $2 AND deleted_at IS NULL LIMIT 1',
    [tenantId, sku],
  )
  if (existing.rowCount && existing.rowCount > 0) return String(existing.rows[0].id)

  const inserted = await client.query(
    `INSERT INTO products (
      tenant_id, sku, name, barcode, retail_price, purchase_price, qty_on_hand,
      unit, is_active, is_service, notes, created_at, updated_at
    )
    VALUES ($1, $2, 'Вільна сума офлайн-каси', NULL, 0, 0, 0, 'шт', true, true, $3, now(), now())
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      is_service = true,
      is_active = true,
      deleted_at = NULL,
      updated_at = now()
    RETURNING id`,
    [tenantId, sku, 'Службовий товар для чеків з довільною сумою, створений синхронізацією'],
  )

  return String(inserted.rows[0].id)
}
