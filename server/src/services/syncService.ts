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
          .select('id,tenant_id,customer_id,make,model,year,vin,notes,created_at,updated_at')
          .eq('tenant_id', tenantId)
          .range(from, to))
      : Promise.resolve([]),
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
        'notes', 'tags', 'price_tier_id', 'bonus_balance', 'vip_level',
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

  if (operation.operation_type === 'sale.completed') {
    await applySaleCompleted(tenantId, userId, operation)
    return
  }

  throw new AppError('SYNC_UNSUPPORTED_OPERATION', `Непідтримувана операція: ${operation.operation_type}`, 400)
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

    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, is_fiscal, completed_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'completed',
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, false, $16, $16, $16
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
