/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { db } from '../../db/supabase.js'
import { hashSecret, isSupportedSecretHash } from '../../lib/secretHash.js'
import { AppError } from '../../middleware/errorHandler.js'
import { listUsers } from '../adminService.js'
import { fetchAllById, fetchAllByTimestamp } from '../syncKeyset.js'
import { buildStaffSyncPayload, canPullStaffDirectory, canPullSupplyData, sanitizeCommercialFieldsForRole } from '../syncRolePolicy.js'
import { IN_FILTER_CHUNK, captureSyncState, fetchShopSettings, isUuid, loadAvailability } from './syncCore.js'
import type { SyncChangesInput } from './syncCore.js'

export async function fetchSecondarySyncData(params: {
  since?: string
  upperBound: string
  tenantId: string
  userId?: string
  role: string
  fullSnapshots: boolean
  historySince?: string
}) {
  const { since, upperBound, tenantId, userId, role, fullSnapshots, historySince } = params
  const canPullStaff = canPullStaffDirectory(role)
  const canPullPayroll = role === 'owner' || role === 'admin'
  const canPullTirePayroll = canPullPayroll || role === 'cashier'
  const canPullCash = ['owner', 'admin', 'manager', 'cashier'].includes(role)
  const canPullReturns = ['owner', 'admin', 'manager', 'cashier'].includes(role)
  const canPullReserves = ['owner', 'admin', 'manager', 'storekeeper', 'cashier'].includes(role)
  const canPullWarehouse = ['owner', 'admin', 'manager', 'storekeeper'].includes(role)
  const canPullCustomerMoney = ['owner', 'admin', 'manager', 'cashier'].includes(role)

  const changed = (buildQuery: () => any, fullSnapshot = false) => fetchAllByTimestamp(buildQuery, {
    timestampColumn: 'updated_at',
    lowerBound: fullSnapshot ? undefined : since,
    upperBound,
  })
  const recentChanged = (table: string) => changed(() => {
    let query = db.from(table).select('*').eq('tenant_id', tenantId)
    if (historySince) query = query.gte('created_at', historySince)
    return query
  }, Boolean(historySince))
  const deletions = (entityType: string) => fetchAllByTimestamp(
    () => db
      .from('sync_deletions')
      .select('entity_id,deleted_at')
      .eq('tenant_id', tenantId)
      .eq('entity_type', entityType),
    {
      timestampColumn: 'deleted_at',
      lowerBound: since,
      upperBound,
      tieBreaker: 'entity_id',
    },
  )
  const childrenForParents = async (
    parentIds: string[],
    buildQuery: (ids: string[]) => any,
  ): Promise<any[]> => {
    const rows: any[] = []
    for (let start = 0; start < parentIds.length; start += IN_FILTER_CHUNK) {
      const ids = parentIds.slice(start, start + IN_FILTER_CHUNK)
      rows.push(...await fetchAllById(() => buildQuery(ids)))
    }
    return rows
  }

  const [
    staff,
    commissionRules,
    salaryPayments,
    cashOperations,
    deletedSalaryPayments,
    deletedCashOperations,
    customerReturns,
    stockReserves,
    warehouseMovements,
    writeoffs,
    bonusTransactions,
    customerDepositTransactions,
  ] = await Promise.all([
    canPullStaff ? listUsers(tenantId) : Promise.resolve([]),
    canPullPayroll
      ? fetchAllById(() => db.from('commission_rules').select('*').eq('tenant_id', tenantId))
      : Promise.resolve([]),
    canPullTirePayroll
      ? changed(
          () => db.from('salary_payments').select('*').eq('tenant_id', tenantId),
          fullSnapshots,
        )
      : Promise.resolve([]),
    canPullCash
      ? recentChanged('cash_operations')
      : Promise.resolve([]),
    canPullTirePayroll ? deletions('salary_payment') : Promise.resolve([]),
    canPullCash ? deletions('cash_operation') : Promise.resolve([]),
    canPullReturns
      ? recentChanged('customer_returns')
      : Promise.resolve([]),
    canPullReserves
      ? changed(
          () => db.from('inventory_reserves').select('*').eq('tenant_id', tenantId),
          fullSnapshots,
        )
      : Promise.resolve([]),
    canPullWarehouse
      ? recentChanged('warehouse_movements')
      : Promise.resolve([]),
    canPullWarehouse
      ? recentChanged('inventory_writeoffs')
      : Promise.resolve([]),
    canPullCustomerMoney
      ? recentChanged('bonus_transactions')
      : Promise.resolve([]),
    canPullCustomerMoney
      ? recentChanged('customer_deposit_transactions')
      : Promise.resolve([]),
  ])

  const [customerReturnItems, writeoffItems] = await Promise.all([
    canPullReturns
      ? childrenForParents(
          customerReturns.map((row: any) => String(row.id)),
          (ids) => db
            .from('customer_return_items')
            .select('*,parent:customer_returns!inner(tenant_id)')
            .eq('parent.tenant_id', tenantId)
            .in('return_id', ids),
        )
      : Promise.resolve([]),
    canPullWarehouse
      ? childrenForParents(
          writeoffs.map((row: any) => String(row.id)),
          (ids) => db
            .from('inventory_writeoff_items')
            .select('*,parent:inventory_writeoffs!inner(tenant_id)')
            .eq('parent.tenant_id', tenantId)
            .in('writeoff_id', ids),
        )
      : Promise.resolve([]),
  ])

  const pinUserIds = (canPullPayroll ? staff.map((user: any) => String(user.id)) : [String(userId ?? '')])
    .filter((id: string) => isUuid(id))
  const staffPins: any[] = []
  for (let index = 0; index < pinUserIds.length; index += IN_FILTER_CHUNK) {
    const ids = pinUserIds.slice(index, index + IN_FILTER_CHUNK)
    const { data, error } = await db
      .from('staff_pins')
      .select('user_id,pin_code,updated_at')
      .in('user_id', ids)
      .lte('updated_at', upperBound)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    for (const row of data ?? []) {
      const stored = String(row.pin_code ?? '')
      const pinHash = stored.length === 4 ? hashSecret(stored) : stored
      if (isSupportedSecretHash(pinHash)) {
        staffPins.push({ user_id: row.user_id, pin_hash: pinHash, updated_at: row.updated_at })
      }
    }
  }
  const tireWorkerIds = new Set(staff.filter((user: any) => user.role === 'tire_worker').map((user: any) => String(user.id)))
  const visibleSalaryPayments = canPullPayroll
    ? salaryPayments
    : salaryPayments.filter((payment: any) => tireWorkerIds.has(String(payment.employee_id)))
  const staffSyncPayload = buildStaffSyncPayload(staff, role)

  return {
    ...staffSyncPayload,
    staff_pins: staffPins,
    commission_rules: commissionRules,
    salary_payments: visibleSalaryPayments,
    deleted_salary_payment_ids: deletedSalaryPayments.map((row) => row.entity_id),
    cash_operations: cashOperations,
    deleted_cash_operation_ids: deletedCashOperations.map((row) => row.entity_id),
    customer_returns: customerReturns,
    customer_return_items: customerReturnItems.map((row) => ({ ...row, parent: undefined })),
    stock_reserves: stockReserves,
    warehouse_movements: warehouseMovements,
    writeoffs,
    writeoff_items: writeoffItems.map((row) => ({ ...row, parent: undefined })),
    bonus_transactions: bonusTransactions,
    customer_deposit_transactions: customerDepositTransactions,
    commission_rules_snapshot_included: canPullPayroll,
    salary_payments_snapshot_included: canPullPayroll && fullSnapshots,
    stock_reserves_snapshot_included: canPullReserves && fullSnapshots,
  }
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
  userId,
  role,
  includeReferences = false,
  resetGeneration = 0,
}: SyncChangesInput) {
  // Every query is bounded by the same immutable upper timestamp.  Rows written
  // later are intentionally replayed by the next request.
  const syncState = await captureSyncState(tenantId)
  const nextCursor = syncState.cursor
  const generationMismatch = Boolean(since && resetGeneration !== syncState.generation)
  const resetRequired = generationMismatch || Boolean(
    since && syncState.resetAt && Date.parse(since) < Date.parse(syncState.resetAt),
  )
  if (resetRequired) {
    return {
      tenant_id: tenantId,
      cursor: nextCursor,
      reset_required: true,
      reset_generation: syncState.generation,
      reset_at: syncState.resetAt,
      references_included: false,
      reference_parent_repair_included: false,
      catalog_structure_snapshot_included: false,
    }
  }
  const referencesIncluded = !since || includeReferences
  const canPullSupply = canPullSupplyData(role)
  const canPullSupplierCatalog = role === 'owner' || role === 'admin'
  const historySince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const snapshotSince = referencesIncluded ? undefined : since

  const changed = (
    buildQuery: () => any,
    lowerBound = snapshotSince,
    timestampColumn = 'updated_at',
    tieBreaker = 'id',
  ) => fetchAllByTimestamp(buildQuery, {
    timestampColumn,
    lowerBound,
    upperBound: nextCursor,
    tieBreaker,
  })
  const childrenForParents = async (
    parentIds: string[],
    buildQuery: (ids: string[]) => any,
  ): Promise<any[]> => {
    const rows: any[] = []
    const uniqueIds = [...new Set(parentIds.filter(isUuid))]
    for (let start = 0; start < uniqueIds.length; start += IN_FILTER_CHUNK) {
      const ids = uniqueIds.slice(start, start + IN_FILTER_CHUNK)
      rows.push(...await fetchAllById(() => buildQuery(ids)))
    }
    return rows
  }
  const activeReferenceQuery = (query: any): any => referencesIncluded
    ? query.is('deleted_at', null)
    : query

  const [
    initialProductRows,
    customerRows,
    supplierRows,
    shifts,
    sales,
    categoryRows,
    brandRows,
    productBarcodeRows,
    productAliasRows,
    productCrossNumberRows,
    customerVehicleRows,
    customerOrders,
    orderPayments,
    supplyInvoices,
    supplierPayments,
    inventorySessions,
    inventoryItems,
    deletedInventorySessions,
    supplierPriceItems,
    supplierPriceImports,
    shopSettings,
    secondary,
  ] = await Promise.all([
    changed(() => {
      let query = db
        .from('products')
        .select('*,brand:brands(id,name),category:categories(id,name)')
        .eq('tenant_id', tenantId)
      if (!since) query = query.is('deleted_at', null)
      return query
    }),
    changed(() => {
      let query = db
        .from('customers')
        .select('*,price_tier:price_tiers(id,name,discount_pct),customer_cars(vin,deleted_at)')
        .eq('tenant_id', tenantId)
      if (!since) query = query.is('deleted_at', null)
      return query
    }),
    canPullSupply
      ? changed(() => {
          let query = db
            .from('suppliers')
            .select('id,tenant_id,name,phone,email,contact_name,notes,is_active,created_at,updated_at,deleted_at')
            .eq('tenant_id', tenantId)
          if (!since) query = query.is('deleted_at', null)
          return query
        })
      : Promise.resolve([]),
    changed(
      () => {
        let query = db.from('shifts').select('*').eq('tenant_id', tenantId)
        if (referencesIncluded) query = query.or(`status.eq.open,opened_at.gte.${historySince}`)
        return query
      },
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => {
        let query = db.from('sales').select('*').eq('tenant_id', tenantId)
        if (referencesIncluded) query = query.gte('completed_at', historySince)
        return query
      },
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => activeReferenceQuery(db
        .from('categories')
        .select('id,tenant_id,parent_id,name,sort_order,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)),
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => activeReferenceQuery(db
        .from('brands')
        .select('id,tenant_id,name,country,tier,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)),
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => activeReferenceQuery(db
        .from('product_barcodes')
        .select('id,tenant_id,product_id,barcode,barcode_type,is_primary,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)),
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => activeReferenceQuery(db
        .from('product_aliases')
        .select('id,tenant_id,product_id,alias,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)),
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => activeReferenceQuery(db
        .from('product_cross_numbers')
        .select('id,tenant_id,product_id,number,normalized_number,number_type,brand,source,is_verified,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)),
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => activeReferenceQuery(db
        .from('customer_cars')
        .select('id,tenant_id,customer_id,make,model,year,vin,notes,created_at,updated_at,deleted_at')
        .eq('tenant_id', tenantId)),
      referencesIncluded ? undefined : since,
    ),
    changed(() => {
      let query = db
        .from('customer_orders')
        .select('*,customer:customers(id,phone,full_name,card_barcode)')
        .eq('tenant_id', tenantId)
      if (!since) query = query.is('deleted_at', null)
      return query
    }),
    changed(
      () => db.from('order_payments').select('*').eq('tenant_id', tenantId),
      referencesIncluded ? undefined : since,
    ),
    canPullSupply
      ? changed(() => {
          let query = db
            .from('supply_invoices')
            .select('*,supplier:suppliers(id,name)')
            .eq('tenant_id', tenantId)
          if (!since) query = query.is('deleted_at', null)
          return query
        }, includeReferences ? undefined : since)
      : Promise.resolve([]),
    canPullSupply
      ? changed(
          () => db
            .from('supplier_payments')
            .select('*,invoice:supply_invoices!inner(tenant_id,deleted_at)')
            .eq('invoice.tenant_id', tenantId)
            .is('invoice.deleted_at', null),
          referencesIncluded ? undefined : since,
        )
      : Promise.resolve([]),
    changed(
      () => db
        .from('inventory_sessions')
        .select('id,tenant_id,name,status,created_by,started_by,started_at,completed_at,created_at,updated_at')
        .eq('tenant_id', tenantId),
      referencesIncluded ? undefined : since,
    ),
    changed(
      () => db
        .from('inventory_items')
        .select('id,session_id,product_id,expected_stock,counted_stock,was_counted,price_checked,observed_retail_price,last_counted_by,created_at,updated_at,product:products!inner(tenant_id)')
        .eq('product.tenant_id', tenantId)
        .eq('was_counted', true),
      referencesIncluded ? undefined : since,
    ),
    fetchAllByTimestamp(
      () => db
        .from('sync_deletions')
        .select('entity_id,deleted_at')
        .eq('tenant_id', tenantId)
        .eq('entity_type', 'inventory_session'),
      {
        timestampColumn: 'deleted_at',
        lowerBound: since,
        upperBound: nextCursor,
        tieBreaker: 'entity_id',
      },
    ),
    canPullSupplierCatalog
      ? changed(
          () => {
            let query = db
              .from('supplier_price_items')
              .select('id,tenant_id,supplier_id,sku,barcode,brand,name,price_kopecks,qty,warehouse_name,created_at,updated_at,deleted_at')
              .eq('tenant_id', tenantId)
            if (!since) query = query.is('deleted_at', null)
            return query
          },
          since,
        )
      : Promise.resolve([]),
    canPullSupplierCatalog
      ? changed(
          () => db
            .from('supplier_price_imports')
            .select('id,tenant_id,supplier_id,filename,status,total_rows,processed_rows,errors_log,created_at,updated_at')
            .eq('tenant_id', tenantId),
          since,
        )
      : Promise.resolve([]),
    fetchShopSettings(tenantId, role),
    fetchSecondarySyncData({
      since,
      upperBound: nextCursor,
      tenantId,
      userId,
      role,
      fullSnapshots: referencesIncluded,
    }),
  ])

  const [saleItems, customerOrderItems, supplyInvoiceItems] = await Promise.all([
    childrenForParents(
      sales.map((row: any) => String(row.id)),
      (ids) => db
        .from('sale_items')
        .select('*,sale:sales!inner(tenant_id),product:products(id,sku,name)')
        .eq('sale.tenant_id', tenantId)
        .in('sale_id', ids),
    ),
    childrenForParents(
      customerOrders.map((row: any) => String(row.id)),
      (ids) => db
        .from('customer_order_items')
        .select('*,order:customer_orders!inner(tenant_id)')
        .eq('order.tenant_id', tenantId)
        .in('order_id', ids),
    ),
    canPullSupply
      ? childrenForParents(
          supplyInvoices.filter((row: any) => !row.deleted_at).map((row: any) => String(row.id)),
          (ids) => db
            .from('supply_invoice_items')
            .select('*,invoice:supply_invoices!inner(tenant_id,deleted_at)')
            .eq('invoice.tenant_id', tenantId)
            .is('invoice.deleted_at', null)
            .in('invoice_id', ids),
        )
      : Promise.resolve([]),
  ])

  // Browser IndexedDB stores reference values inside the product, not by
  // reference-row id.  Any changed/tombstoned reference therefore repairs its
  // parent with all currently active values.
  const referenceProductIds = [...new Set([
    ...productBarcodeRows,
    ...productAliasRows,
    ...productCrossNumberRows,
  ].map((row: any) => String(row.product_id)).filter(isUuid))]
  const repairProductRows = referencesIncluded
    ? []
    : await childrenForParents(
        referenceProductIds,
        (ids) => db
          .from('products')
          .select('*,brand:brands(id,name),category:categories(id,name)')
          .eq('tenant_id', tenantId)
          .is('deleted_at', null)
          .in('id', ids),
      )
  const productRowsById = new Map<string, any>()
  for (const row of [...initialProductRows, ...repairProductRows]) productRowsById.set(String(row.id), row)
  const productRows = [...productRowsById.values()]
  const deletedProductIds = productRows.filter((row) => row.deleted_at).map((row) => row.id)
  const activeProducts = productRows.filter((row) => !row.deleted_at)
  const repairValueProductIds = referencesIncluded
    ? activeProducts.map((row) => String(row.id))
    : referenceProductIds

  const [completeBarcodes, completeAliases, completeCrossNumbers] = await Promise.all([
    childrenForParents(
      repairValueProductIds,
      (ids) => db
        .from('product_barcodes')
        .select('id,product_id,barcode,is_primary')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .in('product_id', ids),
    ),
    childrenForParents(
      repairValueProductIds,
      (ids) => db
        .from('product_aliases')
        .select('id,product_id,alias')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .in('product_id', ids),
    ),
    childrenForParents(
      repairValueProductIds,
      (ids) => db
        .from('product_cross_numbers')
        .select('id,product_id,number')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .in('product_id', ids),
    ),
  ])
  const repairSet = new Set(repairValueProductIds)
  const valuesByProduct = <T>(rows: any[], value: (row: any) => T | null): Map<string, T[]> => {
    const result = new Map<string, T[]>()
    for (const row of rows) {
      const item = value(row)
      if (item === null) continue
      const id = String(row.product_id)
      const values = result.get(id) ?? []
      if (!values.includes(item)) values.push(item)
      result.set(id, values)
    }
    return result
  }
  const additionalBarcodesByProduct = valuesByProduct<string>(
    completeBarcodes,
    (row) => row.is_primary === true ? null : String(row.barcode),
  )
  const aliasesByProduct = valuesByProduct<string>(completeAliases, (row) => String(row.alias))
  const crossNumbersByProduct = valuesByProduct<string>(completeCrossNumbers, (row) => String(row.number))

  const availability = await loadAvailability(activeProducts.map((row) => row.id))
  const products = activeProducts.map((product) => {
    const available = availability.get(product.id)
    const result: Record<string, any> = {
      ...product,
      qty_reserved: available?.qty_reserved ?? 0,
      qty_available: available?.qty_available ?? Number(product.qty_on_hand ?? 0),
    }
    if (repairSet.has(String(product.id))) {
      result.additional_barcodes = additionalBarcodesByProduct.get(String(product.id)) ?? []
      result.aliases = aliasesByProduct.get(String(product.id)) ?? []
      result.cross_numbers = crossNumbersByProduct.get(String(product.id)) ?? []
    }
    if (role === 'cashier') {
      delete result.purchase_price
      delete result.cost_price
    }
    return result
  })

  const deletedCustomerIds = customerRows.filter((row) => row.deleted_at).map((row) => row.id)
  const customers = customerRows
    .filter((row) => !row.deleted_at)
    .map((customer) => {
      const activeCars = Array.isArray(customer.customer_cars)
        ? customer.customer_cars.filter((car: any) => !car.deleted_at)
        : []
      return {
        ...customer,
        primary_vin: activeCars.find((car: any) => car.vin)?.vin ?? null,
        car_count: activeCars.length,
        customer_cars: undefined,
      }
    })

  const deletedSupplierIds = supplierRows.filter((row) => row.deleted_at).map((row) => row.id)
  const suppliers = supplierRows.filter((row) => !row.deleted_at)
  const deletedCustomerOrderIds = customerOrders.filter((row) => row.deleted_at).map((row) => row.id)
  const activeCustomerOrders = sanitizeCommercialFieldsForRole(customerOrders.filter((row) => !row.deleted_at), role)
  const activeCustomerOrderItems = sanitizeCommercialFieldsForRole(
    customerOrderItems
      .filter((row) => !row.deleted_at)
      .map((row) => ({ ...row, order: undefined })),
    role,
  )
  const activeSaleItems = sanitizeCommercialFieldsForRole(
    saleItems.map((row) => ({ ...row, sale: undefined })),
    role,
  )
  const deletedSupplyInvoiceIds = supplyInvoices.filter((row) => row.deleted_at).map((row) => row.id)

  const deletedCategoryIds = categoryRows.filter((row) => row.deleted_at).map((row) => row.id)
  const deletedBrandIds = brandRows.filter((row) => row.deleted_at).map((row) => row.id)
  const deletedProductBarcodeIds = productBarcodeRows.filter((row) => row.deleted_at).map((row) => row.id)
  const deletedProductAliasIds = productAliasRows.filter((row) => row.deleted_at).map((row) => row.id)
  const deletedProductCrossNumberIds = productCrossNumberRows.filter((row) => row.deleted_at).map((row) => row.id)
  const deletedCustomerVehicleIds = customerVehicleRows.filter((row) => row.deleted_at).map((row) => row.id)

  return {
    tenant_id: tenantId,
    cursor: nextCursor,
    reset_required: false,
    reset_generation: syncState.generation,
    reset_at: syncState.resetAt,
    products,
    deleted_product_ids: deletedProductIds,
    customers,
    deleted_customer_ids: deletedCustomerIds,
    suppliers,
    deleted_supplier_ids: deletedSupplierIds,
    shifts,
    sales,
    sale_items: activeSaleItems,
    categories: categoryRows.filter((row) => !row.deleted_at),
    deleted_category_ids: deletedCategoryIds,
    brands: brandRows.filter((row) => !row.deleted_at),
    deleted_brand_ids: deletedBrandIds,
    product_barcodes: productBarcodeRows.filter((row) => !row.deleted_at),
    deleted_product_barcode_ids: deletedProductBarcodeIds,
    product_aliases: productAliasRows.filter((row) => !row.deleted_at),
    deleted_product_alias_ids: deletedProductAliasIds,
    product_cross_numbers: productCrossNumberRows.filter((row) => !row.deleted_at),
    deleted_product_cross_number_ids: deletedProductCrossNumberIds,
    customer_vehicles: customerVehicleRows.filter((row) => !row.deleted_at),
    deleted_customer_vehicle_ids: deletedCustomerVehicleIds,
    customer_orders: activeCustomerOrders,
    deleted_customer_order_ids: deletedCustomerOrderIds,
    customer_order_items: activeCustomerOrderItems,
    order_payments: orderPayments,
    supply_invoices: supplyInvoices.filter((row) => !row.deleted_at),
    deleted_supply_invoice_ids: deletedSupplyInvoiceIds,
    supply_invoice_items: supplyInvoiceItems.map((row) => ({ ...row, invoice: undefined })),
    supplier_payments: supplierPayments.map((row) => ({ ...row, invoice: undefined })),
    supplier_price_items: supplierPriceItems,
    supplier_price_imports: supplierPriceImports,
    inventory_sessions: inventorySessions,
    deleted_inventory_session_ids: deletedInventorySessions.map((row) => row.entity_id),
    inventory_items: inventoryItems.map((row) => ({ ...row, product: undefined })),
    shop_settings: shopSettings,
    ...secondary,
    references_included: referencesIncluded,
    reference_parent_repair_included: true,
    catalog_structure_snapshot_included: referencesIncluded,
  }
}

export async function getBootstrapSnapshot(tenantId: string) {
  // Capture one immutable upper bound before any query starts. Keyset paging
  // avoids OFFSET drift and the first delta safely replays later writes.
  const syncState = await captureSyncState(tenantId)
  const snapshotCursor = syncState.cursor
  const bootstrapHistorySince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const bounded = (
    buildQuery: () => any,
    timestampColumn = 'updated_at',
    lowerBound?: string,
  ) => fetchAllByTimestamp(buildQuery, {
    timestampColumn,
    lowerBound,
    upperBound: snapshotCursor,
  })

  const [
    staff,
    categories,
    brands,
    suppliers,
    shifts,
    sales,
    saleItems,
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
    supplierPriceItems,
    supplierPriceImports,
    shopSettings,
    secondary,
  ] = await Promise.all([
    listUsers(tenantId),
    bounded(() => db
      .from('categories')
      .select('id,tenant_id,parent_id,name,sort_order,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('brands')
      .select('id,tenant_id,name,country,tier,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('suppliers')
      .select('id,tenant_id,name,phone,email,contact_name,notes,is_active,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('shifts')
      .select('*')
      .eq('tenant_id', tenantId)
      .or(`status.eq.open,opened_at.gte.${bootstrapHistorySince}`)),
    bounded(() => db
      .from('sales')
      .select('*')
      .eq('tenant_id', tenantId)
      .gte('completed_at', bootstrapHistorySince)),
    bounded(
      () => db
        .from('sale_items')
        .select('*,sale:sales!inner(tenant_id,completed_at),product:products(id,sku,name)')
        .eq('sale.tenant_id', tenantId)
        .gte('sale.completed_at', bootstrapHistorySince),
      'created_at',
    ),
    bounded(() => db
      .from('products')
      .select([
        'id', 'tenant_id', 'sku', 'name', 'barcode', 'brand_id', 'category_id',
        'unit', 'purchase_price', 'retail_price', 'qty_on_hand', 'reorder_point',
        'notes', 'is_active', 'is_service', 'storage_bin', 'is_favorite',
        'photo_url', 'specs', 'requires_core_return', 'core_deposit_amount',
        'created_at', 'updated_at', 'deleted_at',
      ].join(','))
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('product_barcodes')
      .select('id,tenant_id,product_id,barcode,barcode_type,is_primary,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('product_aliases')
      .select('id,tenant_id,product_id,alias,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('product_cross_numbers')
      .select('id,tenant_id,product_id,number,normalized_number,number_type,brand,source,is_verified,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('customer_cars')
      .select('id,tenant_id,customer_id,make,model,year,vin,notes,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('customer_orders')
      .select('*,customer:customers(id,phone,full_name,card_barcode)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(
      () => db
        .from('customer_order_items')
        .select('*,order:customer_orders!inner(tenant_id,deleted_at)')
        .eq('order.tenant_id', tenantId)
        .is('order.deleted_at', null),
      'created_at',
    ),
    bounded(() => db
      .from('order_payments')
      .select('*,order:customer_orders!inner(tenant_id)')
      .eq('order.tenant_id', tenantId)),
    bounded(() => db
      .from('supply_invoices')
      .select('*,supplier:suppliers(id,name)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(
      () => db
        .from('supply_invoice_items')
        .select('*,invoice:supply_invoices!inner(tenant_id,deleted_at)')
        .eq('invoice.tenant_id', tenantId)
        .is('invoice.deleted_at', null),
      'created_at',
    ),
    bounded(() => db
      .from('supplier_payments')
      .select('*,invoice:supply_invoices!inner(tenant_id,deleted_at)')
      .eq('invoice.tenant_id', tenantId)
      .is('invoice.deleted_at', null)),
    bounded(() => db
      .from('inventory_sessions')
      .select('id,tenant_id,name,status,created_by,started_by,started_at,completed_at,created_at,updated_at')
      .eq('tenant_id', tenantId)),
    bounded(() => db
      .from('inventory_items')
      .select('id,session_id,product_id,expected_stock,counted_stock,was_counted,price_checked,observed_retail_price,last_counted_by,created_at,updated_at,product:products!inner(tenant_id)')
      .eq('product.tenant_id', tenantId)
      .eq('was_counted', true)),
    bounded(() => db
      .from('supplier_price_items')
      .select('id,tenant_id,supplier_id,sku,barcode,brand,name,price_kopecks,qty,warehouse_name,created_at,updated_at,deleted_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)),
    bounded(() => db
      .from('supplier_price_imports')
      .select('id,tenant_id,supplier_id,filename,status,total_rows,processed_rows,errors_log,created_at,updated_at')
      .eq('tenant_id', tenantId)),
    fetchShopSettings(tenantId, 'owner'),
    fetchSecondarySyncData({
      since: undefined,
      historySince: bootstrapHistorySince,
      upperBound: snapshotCursor,
      tenantId,
      role: 'owner',
      fullSnapshots: true,
    }),
  ])

  return {
    exported_at: snapshotCursor,
    tenant_id: tenantId,
    reset_required: false,
    reset_generation: syncState.generation,
    reset_at: syncState.resetAt,
    categories,
    brands,
    suppliers,
    shifts,
    sales,
    sale_items: saleItems.map((row) => ({ ...row, sale: undefined })),
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
    supplier_price_items: supplierPriceItems,
    supplier_price_imports: supplierPriceImports,
    inventory_sessions: inventorySessions,
    inventory_items: inventoryItems.map((row) => ({ ...row, product: undefined })),
    shop_settings: shopSettings,
    ...secondary,
    counts: {
      staff: staff.length,
      staff_pins: secondary.staff_pins.length,
      categories: categories.length,
      brands: brands.length,
      suppliers: suppliers.length,
      shifts: shifts.length,
      sales: sales.length,
      sale_items: saleItems.length,
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
      supplier_price_items: supplierPriceItems.length,
      supplier_price_imports: supplierPriceImports.length,
      inventory_sessions: inventorySessions.length,
      inventory_items: inventoryItems.length,
      settings: shopSettings ? 1 : 0,
    },
  }
}
