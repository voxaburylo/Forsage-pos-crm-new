import { randomUUID } from 'node:crypto'
import { hashSecret, isSupportedSecretHash } from '../lib/secretHash.js'
import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeOemValue } from '../validators/productValidator.js'
import { clearCatalogReferenceCaches, listUsers } from './adminService.js'
import { addOrderPayment } from './orderPaymentService.js'
import {
  applySupplierCatalogImported,
  applySupplierCatalogItemDeleted,
  applySupplierCatalogItemUpsert,
} from './supplierCatalogSyncService.js'
import {
  buildStaffSyncPayload,
  canPullStaffDirectory,
  canPullSupplyData,
  sanitizeCommercialFieldsForRole,
} from './syncRolePolicy.js'
import { nextSettingsRowUpdatedAt, prepareLabelSettingsUpdate } from './labelSettingsConflict.js'
import { clearProductSearchCache } from './productService.js'
import { processSyncBatch } from './syncBatch.js'
import { buildProductSyncQueryValues } from './syncProductValues.js'
import { checkedSyncMoney } from './syncMoney.js'
import { fetchAllById, fetchAllByTimestamp } from './syncKeyset.js'
import { withTenantSyncGenerationGuard } from './syncGeneration.js'

// Фільтр .in() їде в URL: 1000 UUID — це ~37 000 символів, і сервер відхиляє
// такий запит як Bad Request (уся синхронізація падала з DB_ERROR). Ліміт на
// сторінку вибірки тут не годиться — потрібен окремий, менший крок.
// Спільна основа переїхала в ./sync/syncCore.ts — див. коментар там.
export type { SyncChangesInput, SyncOutboxOperation, SyncPushResult } from './sync/syncCore.js'
import {
  ORDER_STATUS_TRANSITIONS,
  IN_FILTER_CHUNK,
  captureSyncState,
  captureDatabaseAppliedAt,
  isUuid,
  uuidOr,
  pickShopSettingsPayload,
  fetchShopSettings,
  loadAvailability,
  assertSyncOperationAllowed,
} from './sync/syncCore.js'
import type { SyncChangesInput, SyncOutboxOperation, SyncPushResult } from './sync/syncCore.js'
import { invoiceLineTotal, normalizePaymentMethod, sumPayments } from './sync/syncMath.js'
import { applyStaffPinUpdated, applyStaffUserUpsert, applyStaffUserDeleted, applyCommissionRuleCreated, applyCommissionRuleDeleted, applySalaryPaymentCreated, applySalaryPaymentDeleted } from './sync/staffHandlers.js'
import { assertProductReferenceExists, assertSyncCashboxHasFunds, ensureFreeAmountProduct } from './sync/syncGuards.js'
async function fetchSecondarySyncData(params: {
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
export async function pushLocalOperations(params: {
  tenantId: string
  userId: string
  role: string
  resetGeneration: number
  operations: SyncOutboxOperation[]
}): Promise<{
  results: SyncPushResult[]
  reset_required: boolean
  reset_generation: number
  reset_at: string | null
}> {
  const guarded = await withTenantSyncGenerationGuard(
    params.tenantId,
    params.resetGeneration,
    async () => processSyncBatch(params.operations, async (operation) => {
      if (operation.tenant_id !== params.tenantId) {
        throw new AppError('SYNC_TENANT_MISMATCH', 'Операція належить іншому магазину', 403)
      }

      assertSyncOperationAllowed(params.role, operation.operation_type)
      const restrictedCustomerWrite = ['customer.created', 'customer.updated'].includes(operation.operation_type)
        && !['owner', 'admin', 'manager'].includes(params.role)
      const rawPayload = { ...(operation.payload ?? {}) }
      const originalPayload = restrictedCustomerWrite
        ? Object.fromEntries(Object.entries(rawPayload).filter(([key]) => [
            'id', 'phone', 'full_name', 'email', 'notes', 'card_barcode', 'birth_date', 'created_at',
          ].includes(key)))
        : rawPayload
      if (originalPayload.created_at === undefined) originalPayload.created_at = operation.created_at
      // Read DB time immediately before this operation. A single batch timestamp
      // can fall behind a cursor while later independent transactions are waiting.
      const appliedAt = await captureDatabaseAppliedAt()
      const operationForApply: SyncOutboxOperation = {
        ...operation,
        created_at: appliedAt,
        applied_at: appliedAt,
        payload: originalPayload,
      }

      await applyLocalOperation({
        tenantId: params.tenantId,
        userId: params.userId,
        role: params.role,
        operation: operationForApply,
      })
    }),
  )

  if (!guarded.matched) {
    const results = params.operations.map<SyncPushResult>((operation) => {
      if (operation.tenant_id !== params.tenantId) {
        return {
          sequence: operation.sequence,
          operation_id: operation.operation_id,
          aggregate_id: operation.aggregate_id,
          status: 'failed',
          error: 'Операція належить іншому магазину',
        }
      }
      return {
        sequence: operation.sequence,
        operation_id: operation.operation_id,
        aggregate_id: operation.aggregate_id,
        status: 'discarded',
        error_code: 'SYNC_RESET_REQUIRED',
        error: 'Локальна копія належить іншому поколінню даних; потрібно виконати повне оновлення',
        reset_generation: guarded.state.generation,
        reset_at: guarded.state.resetAt ?? undefined,
      }
    }).sort((left, right) => left.sequence - right.sequence)
    return {
      results,
      reset_required: true,
      reset_generation: guarded.state.generation,
      reset_at: guarded.state.resetAt,
    }
  }

  return {
    results: (guarded.value as SyncPushResult[]).sort((left, right) => left.sequence - right.sequence),
    reset_required: false,
    reset_generation: guarded.state.generation,
    reset_at: guarded.state.resetAt,
  }
}
async function applyLocalOperation(params: {
  tenantId: string
  userId: string
  role: string
  operation: SyncOutboxOperation
}): Promise<void> {
  const { operation, tenantId, userId, role } = params

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
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'product.deleted') {
    await applyProductDeleted(tenantId, operation)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'category.upsert') {
    await applyCategoryUpsert(tenantId, operation, role)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'category.deleted') {
    await applyCategoryDeleted(tenantId, operation)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'brand.upsert') {
    await applyBrandUpsert(tenantId, operation, role)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'brand.deleted') {
    await applyBrandDeleted(tenantId, operation)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'settings.updated') {
    await applySettingsUpdated(tenantId, operation)
    return
  }

  if (operation.operation_type === 'inventory.created') {
    await applyInventoryCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'inventory.started') {
    await applyInventoryStarted(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'inventory.deleted') {
    await applyInventoryDeleted(tenantId, operation)
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
  if (operation.operation_type === 'customer.bonus_adjusted') {
    await applyCustomerBonusAdjusted(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'supplier_catalog.item_upserted') {
    await applySupplierCatalogItemUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier_catalog.item_deleted') {
    await applySupplierCatalogItemDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier_catalog.imported') {
    await applySupplierCatalogImported(tenantId, operation)
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

  if (operation.operation_type === 'customer.created' || operation.operation_type === 'customer.updated') {
    await applyCustomerUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'customer.deleted') {
    await applyCustomerDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'customer_vehicle.created' || operation.operation_type === 'customer_vehicle.updated') {
    await applyCustomerVehicleUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'customer_vehicle.deleted') {
    await applyCustomerVehicleDeleted(tenantId, operation)
    return
  }

  if (operation.operation_type === 'supplier.created' || operation.operation_type === 'supplier.updated') {
    await applySupplierUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier.deleted') {
    await applySupplierDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier.merged') {
    await applySupplierMerged(tenantId, operation)
    return
  }

  if (operation.operation_type === 'order.created' || operation.operation_type === 'order.updated') {
    await applyOrderUpsert(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.deleted') {
    await applyOrderDeleted(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.status_updated') {
    await applyOrderStatusUpdated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.item_status_updated') {
    await applyOrderItemStatusUpdated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.items_arrived') {
    await applyOrderItemsArrived(tenantId, operation)
    return
  }
  if (operation.operation_type === 'order.canceled') {
    await applyOrderCanceled(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'staff_pin.updated') {
    await applyStaffPinUpdated(tenantId, operation)
    return
  }
  if (operation.operation_type === 'staff_user.created' || operation.operation_type === 'staff_user.updated') {
    await applyStaffUserUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'staff_user.deleted') {
    await applyStaffUserDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'commission_rule.created') {
    await applyCommissionRuleCreated(tenantId, operation)
    return
  }
  if (operation.operation_type === 'commission_rule.deleted') {
    await applyCommissionRuleDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'salary_payment.created') {
    await applySalaryPaymentCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'salary_payment.deleted') {
    await applySalaryPaymentDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'cash_operation.created') {
    await applyCashOperationCreated(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'reserve.created') {
    await applyReserveCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'reserve.released') {
    await applyReserveReleased(tenantId, operation)
    return
  }
  if (operation.operation_type === 'warehouse_movement.created') {
    await applyWarehouseMovementCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'writeoff.created') {
    await applyWriteoffCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'return.created') {
    await applyReturnCreated(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'sale.suspended') {
    await applySuspendedSale(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'sale.suspended_resumed' || operation.operation_type === 'sale.suspended_deleted') {
    await applySuspendedSaleClosed(tenantId, operation)
    return
  }

  throw new AppError('SYNC_UNSUPPORTED_OPERATION', `Непідтримувана операція: ${operation.operation_type}`, 400)
}



async function applyCustomerUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const incomingPayload = operation.payload ?? {}
  let payload = incomingPayload
  const customerId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(customerId)) throw new AppError('SYNC_CUSTOMER_INVALID', 'Некоректний ідентифікатор клієнта', 400)
  const timestamp = operation.applied_at ?? new Date().toISOString()
  const birthDateProvided = Object.prototype.hasOwnProperty.call(incomingPayload, 'birth_date')

  await runTransaction(async (client) => {
    const existingResult = await client.query(
      'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
      [customerId, tenantId],
    )
    const existing = existingResult.rows[0]
    if (existing) {
      payload = {
        ...existing,
        ...incomingPayload,
        debt_balance: existing.debt_balance,
        deposit_balance: existing.deposit_balance,
        bonus_balance: existing.bonus_balance,
      }
    }

    await client.query(
      `INSERT INTO customers (
        id, tenant_id, phone, full_name, email, debt_balance,
        deposit_balance, loyalty_mode, notes, tags, price_tier_id, bonus_balance,
        vip_level, risk_profile, discount_pct, client_status, card_barcode,
        created_at, updated_at, deleted_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        phone = EXCLUDED.phone,
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        debt_balance = EXCLUDED.debt_balance,
        deposit_balance = EXCLUDED.deposit_balance,
        loyalty_mode = EXCLUDED.loyalty_mode,
        notes = EXCLUDED.notes,
        tags = EXCLUDED.tags,
        price_tier_id = EXCLUDED.price_tier_id,
        bonus_balance = EXCLUDED.bonus_balance,
        vip_level = EXCLUDED.vip_level,
        risk_profile = EXCLUDED.risk_profile,
        discount_pct = EXCLUDED.discount_pct,
        client_status = EXCLUDED.client_status,
        card_barcode = EXCLUDED.card_barcode,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE customers.tenant_id = EXCLUDED.tenant_id`,
      [
        customerId,
        tenantId,
        payload.phone?.trim() || null,
        payload.full_name?.trim() || null,
        payload.email?.trim() || null,
        Number(payload.debt_balance ?? 0),
        Number(payload.deposit_balance ?? 0),
        payload.loyalty_mode === 'cashback' ? 'cashback' : 'discount',
        payload.notes ?? null,
        Array.isArray(payload.tags) ? payload.tags : [],
        isUuid(payload.price_tier_id) ? payload.price_tier_id : null,
        Number(payload.bonus_balance ?? 0),
        payload.vip_level ?? 'standard',
        payload.risk_profile ?? 'low',
        Number(payload.discount_pct ?? 0),
        payload.client_status ?? 'client',
        payload.card_barcode?.trim() || null,
        timestamp,
      ],
    )

    if (birthDateProvided) {
      const hasBirthDate = await client.query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'customers'
           AND column_name = 'birth_date'
         LIMIT 1`,
      )
      if (hasBirthDate.rowCount) {
        await client.query(
          'UPDATE customers SET birth_date = $3 WHERE id = $1 AND tenant_id = $2',
          [customerId, tenantId, payload.birth_date || null],
        )
      }
    }
  })
}

async function applyCustomerDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const customer = await client.query(
      `SELECT COALESCE(debt_balance, 0) AS debt_balance,
              COALESCE(deposit_balance, 0) AS deposit_balance,
              COALESCE(bonus_balance, 0) AS bonus_balance
       FROM customers
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    if (!customer.rowCount) return
    const row = customer.rows[0]
    if (Number(row.debt_balance) !== 0 || Number(row.deposit_balance) !== 0 || Number(row.bonus_balance) !== 0) {
      throw new AppError('SYNC_CUSTOMER_HAS_BALANCE', 'Клієнта не можна видалити, доки є борг, передплата або бонуси', 409)
    }
    const activeOrder = await client.query(
      `SELECT 1 FROM customer_orders
       WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         AND status NOT IN ('completed', 'cancelled', 'canceled', 'archived')
       LIMIT 1`,
      [operation.aggregate_id, tenantId],
    )
    if (activeOrder.rowCount) {
      throw new AppError('SYNC_CUSTOMER_HAS_ACTIVE_ORDERS', 'У клієнта є незавершені замовлення або чернетки', 409)
    }
    await client.query(
      `UPDATE customer_cars
       SET deleted_at = $3, updated_at = $3
       WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
    await client.query(
      'UPDATE customers SET deleted_at = $3, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}
async function applyCustomerVehicleUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const vehicleId = String(payload.id ?? operation.aggregate_id)
  const customerId = String(payload.customer_id ?? '')
  if (!isUuid(vehicleId) || !isUuid(customerId)) {
    throw new AppError('SYNC_CUSTOMER_VEHICLE_INVALID', 'Некоректні дані автомобіля клієнта', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const customer = await client.query(
      'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
      [customerId, tenantId],
    )
    if (!customer.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта автомобіля не знайдено', 404)
    await client.query(
      `INSERT INTO customer_cars (
        id, tenant_id, customer_id, make, model, year, vin, notes,
        created_at, updated_at, deleted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)
      ON CONFLICT (id) DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        vin = EXCLUDED.vin,
        notes = EXCLUDED.notes,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE customer_cars.tenant_id = EXCLUDED.tenant_id`,
      [
        vehicleId,
        tenantId,
        customerId,
        String(payload.brand ?? payload.make ?? '').trim() || 'Авто',
        String(payload.model ?? '').trim() || '—',
        Number.isFinite(Number(payload.year)) ? Number(payload.year) : null,
        payload.vin?.trim()?.toUpperCase() || null,
        payload.notes ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}
async function applyCustomerVehicleDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE customer_cars
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}
async function applySupplierUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const supplierId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(supplierId) || !name) throw new AppError('SYNC_SUPPLIER_INVALID', 'Постачальник має містити id і назву', 400)
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO suppliers (
        id, tenant_id, name, phone, email, contact_name, notes, is_active,
        created_at, updated_at, deleted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,NULL)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        contact_name = EXCLUDED.contact_name,
        notes = EXCLUDED.notes,
        is_active = EXCLUDED.is_active,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE suppliers.tenant_id = EXCLUDED.tenant_id`,
      [
        supplierId, tenantId, name, payload.phone ?? null, payload.email ?? null,
        payload.contact_name ?? null, payload.notes ?? null, payload.is_active !== false,
        operation.created_at,
      ],
    )
  })
}

async function applySupplierDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    await client.query(
      'UPDATE suppliers SET deleted_at = $3, is_active = false, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId, operation.created_at],
    )
  })
}

async function applySupplierMerged(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const primaryId = String(payload.primary_supplier_id ?? operation.aggregate_id)
  const duplicateId = String(payload.duplicate_supplier_id ?? '')
  if (!isUuid(primaryId) || !isUuid(duplicateId) || primaryId === duplicateId) {
    throw new AppError('SYNC_SUPPLIER_MERGE_INVALID', 'Некоректне об’єднання постачальників', 400)
  }
  await runTransaction(async (client) => {
    const primary = await client.query('SELECT id FROM suppliers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL', [primaryId, tenantId])
    if (!primary.rowCount) throw new AppError('SYNC_SUPPLIER_NOT_FOUND', 'Основного постачальника не знайдено', 404)
    await client.query('UPDATE supply_invoices SET supplier_id = $1, updated_at = $3 WHERE supplier_id = $2 AND tenant_id = $4', [primaryId, duplicateId, operation.created_at, tenantId])
    await client.query(
      'UPDATE supplier_payments SET supplier_id = $1, updated_at = $4 WHERE supplier_id = $2 AND tenant_id = $3',
      [primaryId, duplicateId, tenantId, operation.created_at],
    )
    await client.query('UPDATE suppliers SET deleted_at = $3, is_active = false, updated_at = $3 WHERE id = $1 AND tenant_id = $2', [duplicateId, tenantId, operation.created_at])
  })
}



async function applyOrderUpsert(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(orderId)) throw new AppError('SYNC_ORDER_INVALID', 'Некоректний ідентифікатор замовлення', 400)
  const hasIncomingItems = Array.isArray(payload.items)
  const items = hasIncomingItems ? payload.items : []
  const timestamp = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existingResult = await client.query(
      'SELECT * FROM customer_orders WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
      [orderId, tenantId],
    )
    const existing = existingResult.rows[0] ?? null
    // A delayed editor snapshot must never reopen or rewrite a terminal order.
    if (existing && ['completed', 'canceled', 'archived'].includes(String(existing.status))) return
    const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key)
    const fromPayload = (key: string, fallback: any): any => owns(key) ? payload[key] : fallback
    const managerId = uuidOr(fromPayload('manager_id', existing?.manager_id), userId)
    const orderNumberValue = fromPayload('order_number', existing?.order_number ?? null)
    const orderNumber = Number.isFinite(Number(orderNumberValue)) ? Number(orderNumberValue) : null
    const requestedStatus = String(fromPayload('status', existing?.status ?? 'lead'))
    if (!new Set(['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready']).has(requestedStatus)) {
      throw new AppError('SYNC_ORDER_STATUS_INVALID', 'Закриття замовлення виконується тільки окремою безпечною операцією', 409)
    }
    const exchangeSourceId = isUuid(fromPayload('exchange_source_order_id', existing?.exchange_source_order_id))
      ? String(fromPayload('exchange_source_order_id', existing?.exchange_source_order_id))
      : null
    if (!existing && exchangeSourceId) {
      const source = await client.query(
        `SELECT id FROM customer_orders
         WHERE id = $1 AND tenant_id = $2 AND status = 'completed' AND sale_id IS NOT NULL AND deleted_at IS NULL`,
        [exchangeSourceId, tenantId],
      )
      if (!source.rowCount) throw new AppError('SYNC_EXCHANGE_SOURCE_INVALID', 'Обмін можна створити тільки для виданого замовлення з чеком', 409)
    }

    await client.query(
      `INSERT INTO customer_orders (
        id, tenant_id, order_number, customer_id, chat_id, manager_id, vehicle_info,
        status, prepayment, prepayment_method, prepayment_is_fiscal, total_amount,
        total_paid, discount_amount, pickup_deadline_at, pickup_cell, comment, source,
        exchange_source_order_id, created_at, updated_at, deleted_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,$17,$18,$19,$20,NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        order_number = EXCLUDED.order_number,
        customer_id = EXCLUDED.customer_id,
        chat_id = EXCLUDED.chat_id,
        manager_id = EXCLUDED.manager_id,
        vehicle_info = EXCLUDED.vehicle_info,
        status = EXCLUDED.status,
        prepayment = EXCLUDED.prepayment,
        prepayment_method = EXCLUDED.prepayment_method,
        prepayment_is_fiscal = EXCLUDED.prepayment_is_fiscal,
        total_amount = EXCLUDED.total_amount,
        total_paid = EXCLUDED.total_paid,
        discount_amount = 0,
        pickup_deadline_at = EXCLUDED.pickup_deadline_at,
        pickup_cell = EXCLUDED.pickup_cell,
        comment = EXCLUDED.comment,
        source = EXCLUDED.source,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE customer_orders.tenant_id = EXCLUDED.tenant_id`,
      [
        orderId,
        tenantId,
        orderNumber,
        isUuid(fromPayload('customer_id', existing?.customer_id)) ? fromPayload('customer_id', existing?.customer_id) : null,
        isUuid(fromPayload('chat_id', existing?.chat_id)) ? fromPayload('chat_id', existing?.chat_id) : null,
        managerId,
        fromPayload('vehicle_info', existing?.vehicle_info ?? null),
        requestedStatus,
        Number(existing?.prepayment ?? 0),
        fromPayload('prepayment_method', existing?.prepayment_method ?? null),
        fromPayload('prepayment_is_fiscal', existing?.prepayment_is_fiscal ?? false) === true,
        Number(fromPayload('total_amount', existing?.total_amount ?? 0)),
        Number(existing?.total_paid ?? 0),
        fromPayload('pickup_deadline_at', existing?.pickup_deadline_at ?? null),
        fromPayload('pickup_cell', existing?.pickup_cell ?? null),
        fromPayload('comment', existing?.comment ?? null),
        fromPayload('source', existing?.source ?? 'walk_in'),
        exchangeSourceId,
        existing?.created_at ?? payload.created_at ?? timestamp,
        timestamp,
      ],
    )

    if (!hasIncomingItems && existing) return

    const incomingIds: string[] = []
    for (const item of items) {
      const itemId = isUuid(item?.id) ? item.id : randomUUID()
      const requestedItemStatus = String(item?.item_status ?? 'pending')
      if (!new Set(['pending', 'ordered', 'arrived', 'canceled']).has(requestedItemStatus)) {
        throw new AppError('SYNC_ORDER_ITEM_STATUS_INVALID', 'Видача або повернення позиції виконується тільки через касу', 409)
      }
      incomingIds.push(itemId)
      await client.query(
        `INSERT INTO customer_order_items (
          id, order_id, product_id, sku, name, supplier_id, source_type, item_type,
          item_status, buy_price, sell_price, qty, expected_date,
          core_deposit_amount, core_return_status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          sku = EXCLUDED.sku,
          name = EXCLUDED.name,
          supplier_id = EXCLUDED.supplier_id,
          source_type = EXCLUDED.source_type,
          item_type = EXCLUDED.item_type,
          item_status = EXCLUDED.item_status,
          buy_price = EXCLUDED.buy_price,
          sell_price = EXCLUDED.sell_price,
          qty = EXCLUDED.qty,
          expected_date = EXCLUDED.expected_date,
          core_deposit_amount = EXCLUDED.core_deposit_amount,
          core_return_status = EXCLUDED.core_return_status
        WHERE customer_order_items.order_id = EXCLUDED.order_id`,
        [
          itemId,
          orderId,
          isUuid(item?.product_id) ? item.product_id : null,
          item?.sku ?? null,
          String(item?.name ?? 'Товар'),
          isUuid(item?.supplier_id) ? item.supplier_id : null,
          item?.source_type === 'warehouse' ? 'warehouse' : 'supplier',
          item?.item_type === 'service' ? 'service' : 'product',
          requestedItemStatus,
          Number(item?.buy_price ?? 0),
          Number(item?.sell_price ?? 0),
          Number(item?.qty ?? 1),
          item?.expected_date ?? null,
          Number(item?.core_deposit_amount ?? 0),
          item?.core_return_status ?? 'none',
          item?.created_at ?? timestamp,
        ],
      )
    }

    if (incomingIds.length > 0) {
      await client.query(
        'DELETE FROM customer_order_items WHERE order_id = $1 AND NOT (id = ANY($2::uuid[]))',
        [orderId, incomingIds],
      )
    } else {
      await client.query('DELETE FROM customer_order_items WHERE order_id = $1', [orderId])
    }
  })
}

async function applyOrderDeleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    const order = await client.query(
      `SELECT o.status, o.prepayment, o.total_paid, o.sale_id,
              COUNT(p.id)::integer AS payment_count,
              COALESCE(SUM(p.amount), 0)::bigint AS ledger_paid
       FROM customer_orders o
       LEFT JOIN order_payments p
         ON p.order_id = o.id AND p.tenant_id = o.tenant_id
       WHERE o.id = $1 AND o.tenant_id = $2 AND o.deleted_at IS NULL
       GROUP BY o.id
       FOR UPDATE OF o`,
      [operation.aggregate_id, tenantId],
    )
    if (!order.rowCount) return
    const row = order.rows[0]
    if (!['lead', 'quoted', 'new'].includes(String(row.status))
      || Number(row.prepayment ?? 0) !== 0
      || Number(row.total_paid ?? 0) !== 0
      || Number(row.payment_count ?? 0) !== 0
      || Number(row.ledger_paid ?? 0) !== 0
      || row.sale_id) {
      throw new AppError('SYNC_ORDER_DELETE_FORBIDDEN', 'Видалити можна лише неоплачений чернетковий заказ', 409)
    }
    await client.query(
      'UPDATE customer_orders SET deleted_at = $3, deleted_by = $4, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId, operation.created_at, userId],
    )
    await client.query(
      `UPDATE inventory_reserves
       SET released_at = COALESCE(released_at, $3)
       WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [operation.aggregate_id, tenantId, operation.created_at],
    )
  })
}

async function applyOrderStatusUpdated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const status = String(operation.payload?.status ?? '')
  const allowed = new Set(['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready'])
  if (!allowed.has(status)) {
    throw new AppError('SYNC_ORDER_STATUS_INVALID', 'Видача та скасування замовлення виконуються окремою безпечною операцією', 409)
  }
  await runTransaction(async (client) => {
    const current = await client.query(
      `SELECT status FROM customer_orders WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    if (!current.rowCount || ['completed', 'canceled', 'archived'].includes(String(current.rows[0].status))) {
      throw new AppError('SYNC_ORDER_IMMUTABLE', 'Замовлення не знайдено або його вже закрито', 409)
    }
    const from = String(current.rows[0].status)
    if (from !== status && !(ORDER_STATUS_TRANSITIONS[from] ?? []).includes(status)) {
      throw new AppError('SYNC_ORDER_STATUS_TRANSITION_INVALID', 'Недоступний перехід статусу замовлення', 409)
    }
    await client.query('SELECT update_customer_order_status($1, $2, $3, $4)', [tenantId, operation.aggregate_id, status, userId])
  })
}

async function applyOrderItemStatusUpdated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  if (!isUuid(payload.item_id)) throw new AppError('SYNC_ORDER_ITEM_INVALID', 'Некоректна позиція замовлення', 400)
  const itemStatus = String(payload.item_status ?? '')
  if (!new Set(['pending', 'ordered', 'arrived', 'canceled']).has(itemStatus)) {
    throw new AppError('SYNC_ORDER_ITEM_STATUS_INVALID', 'Видача або повернення позиції виконується тільки через касу', 409)
  }
  await runTransaction(async (client) => {
    const result = await client.query(
      `UPDATE customer_order_items i
       SET item_status = $3
       FROM customer_orders o
       WHERE i.id = $1 AND i.order_id = o.id AND o.tenant_id = $2 AND o.deleted_at IS NULL
         AND o.status NOT IN ('completed', 'canceled', 'archived')
       RETURNING i.order_id`,
      [payload.item_id, tenantId, itemStatus],
    )
    if (!result.rowCount) throw new AppError('SYNC_ORDER_ITEM_IMMUTABLE', 'Позицію не знайдено або замовлення вже закрито', 409)
    const orderId = result.rows[0].order_id
    const state = await client.query(
      `SELECT item_status, sell_price, qty, COALESCE(core_deposit_amount, 0) AS core_deposit_amount
       FROM customer_order_items WHERE order_id = $1`,
      [orderId],
    )
    const active = state.rows.filter((item) => item.item_status !== 'canceled')
    const total = active.reduce((sum, item) => sum + Number(item.sell_price) * Number(item.qty) + Number(item.core_deposit_amount) * Number(item.qty), 0)
    const nextStatus = active.length > 0 && active.every((item) => ['arrived', 'handed', 'returned'].includes(item.item_status))
      ? 'ready'
      : active.some((item) => item.item_status === 'ordered')
        ? 'ordered'
        : 'new'
    await client.query(
      'UPDATE customer_orders SET total_amount = $3, status = $4, updated_at = $5 WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId, total, nextStatus, operation.applied_at ?? operation.created_at],
    )
    if (itemStatus === 'canceled' || itemStatus === 'pending') {
      await client.query('SELECT reserve_order_items($1, $2, $3)', [tenantId, orderId, userId])
    }
  })
}

async function applyOrderItemsArrived(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const ids = [...new Set((Array.isArray(operation.payload?.item_ids) ? operation.payload.item_ids : []).filter(isUuid))]
  if (ids.length === 0) return
  await runTransaction(async (client) => {
    const owned = await client.query(
      `SELECT i.id, i.order_id
       FROM customer_order_items i
       JOIN customer_orders o ON o.id = i.order_id
       WHERE i.id = ANY($1::uuid[])
         AND o.tenant_id = $2
         AND o.deleted_at IS NULL
         AND o.status NOT IN ('completed', 'canceled', 'archived')
       FOR UPDATE OF i`,
      [ids, tenantId],
    )
    if (owned.rowCount !== ids.length) {
      throw new AppError('SYNC_ORDER_ITEM_NOT_FOUND', 'Одна або кілька позицій не знайдені у вашому магазині', 404)
    }
    await client.query(
      `UPDATE customer_order_items i
       SET item_status = 'arrived'
       FROM customer_orders o
       WHERE i.id = ANY($1::uuid[])
         AND i.order_id = o.id
         AND o.tenant_id = $2
         AND o.deleted_at IS NULL`,
      [ids, tenantId],
    )
    await client.query(
      `UPDATE customer_orders SET updated_at = $3
       WHERE tenant_id = $2
         AND id = ANY($1::uuid[])`,
      [[...new Set(owned.rows.map((row) => row.order_id))], tenantId, operation.applied_at ?? operation.created_at],
    )
  })
}

async function applyOrderCanceled(
  tenantId: string,
  userId: string,
  operation: SyncOutboxOperation,
): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const orderResult = await client.query(
      `SELECT status, comment, total_paid, prepayment, customer_id, order_number
       FROM customer_orders
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    if (!orderResult.rowCount) throw new AppError('SYNC_ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    const order = orderResult.rows[0]
    if (order.status === 'completed' || order.status === 'archived') {
      throw new AppError('SYNC_ORDER_COMPLETED', 'Завершене або архівне замовлення не можна скасувати', 409)
    }
    if (order.status === 'canceled') return

    const payments = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid_amount
       FROM order_payments
       WHERE order_id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId],
    )
    const paidAmount = Math.max(
      Number(order.total_paid ?? 0),
      Number(order.prepayment ?? 0),
      Number(payments.rows[0]?.paid_amount ?? 0),
    )
    const timestamp = operation.applied_at ?? operation.created_at
    let customerBalance: number | null = null
    let creditedAmount = 0
    if (paidAmount > 0) {
      const customerId = String(order.customer_id ?? '')
      if (!customerId) {
        throw new AppError(
          'SYNC_ORDER_CUSTOMER_REQUIRED_FOR_CREDIT',
          'До оплаченого замовлення не прив’язаний клієнт',
          422,
        )
      }
      const existingCredit = await client.query(
        `SELECT amount, balance_after
         FROM customer_deposit_transactions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1`,
        [operation.aggregate_id, tenantId],
      )
      if (existingCredit.rowCount) {
        creditedAmount = Number(existingCredit.rows[0].amount ?? 0)
        customerBalance = Number(existingCredit.rows[0].balance_after ?? 0)
      } else {
        const customerResult = await client.query(
          `SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
           FROM customers
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           LIMIT 1 FOR UPDATE`,
          [customerId, tenantId],
        )
        if (!customerResult.rowCount) {
          throw new AppError('SYNC_ORDER_CUSTOMER_NOT_FOUND', 'Клієнта замовлення не знайдено', 404)
        }
        customerBalance = Number(customerResult.rows[0].deposit_balance ?? 0) + paidAmount
        await client.query(
          `UPDATE customers
           SET deposit_balance = $3, updated_at = $4
           WHERE id = $1 AND tenant_id = $2`,
          [customerId, tenantId, customerBalance, timestamp],
        )
        await client.query(
          `INSERT INTO customer_deposit_transactions (
             id, tenant_id, customer_id, amount, balance_after, method, order_id,
             notes, created_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'account', $1, $6, $7, $8, $8)`,
          [
            operation.aggregate_id, tenantId, customerId, paidAmount, customerBalance,
            `Скасування замовлення №${String(order.order_number ?? operation.aggregate_id)}`,
            userId, timestamp,
          ],
        )
        creditedAmount = paidAmount
      }
    }

    const priorComment = String(order.comment ?? '').trim()
    const reason = String(payload.reason ?? '').trim()
    const comment = reason ? `${priorComment ? `${priorComment}\n` : ''}Скасування: ${reason}` : priorComment || null
    await client.query(
      `UPDATE customer_orders
       SET status = 'canceled', comment = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, comment, timestamp],
    )
    await client.query(
      `UPDATE inventory_reserves SET released_at = $3
       WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [operation.aggregate_id, tenantId, timestamp],
    )
    await client.query(
      `UPDATE customer_order_items i
       SET item_status = 'canceled'
       FROM customer_orders o
       WHERE i.order_id = $1
         AND i.order_id = o.id
         AND o.tenant_id = $2
         AND i.item_status <> 'handed'`,
      [operation.aggregate_id, tenantId],
    )
    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'canceled', $3::jsonb, $4)`,
      [
        operation.aggregate_id,
        userId,
        JSON.stringify({ reason: payload.reason ?? null, credited_amount: creditedAmount, customer_balance: customerBalance, source: 'desktop_sync' }),
        timestamp,
      ],
    )
  })
}







async function applyCashOperationCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  const amount = Math.round(Number(payload.amount ?? 0))
  if (!isUuid(id) || amount <= 0) throw new AppError('SYNC_CASH_OPERATION_INVALID', 'Некоректна касова операція', 400)
  const type = payload.type === 'out' || payload.type === 'cash_out' || payload.type === 'salary_payout' || payload.type === 'supplier_payment'
    ? 'out'
    : 'in'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO cash_operations (
        id, tenant_id, shift_id, type, amount, note, source, created_by, employee_id, work_date, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO NOTHING`,
      [
        id,
        tenantId,
        isUuid(payload.shift_id) ? payload.shift_id : null,
        type,
        amount,
        payload.note ?? payload.notes ?? null,
        payload.source ?? 'cashbox',
        uuidOr(payload.user_id ?? payload.created_by, userId),
        isUuid(payload.employee_id) ? payload.employee_id : null,
        /^\d{4}-\d{2}-\d{2}$/.test(String(payload.work_date ?? '')) ? payload.work_date : null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

async function applyReserveCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  const qty = Number(payload.qty ?? 0)
  if (!isUuid(id) || !isUuid(payload.product_id) || !Number.isFinite(qty) || qty <= 0) {
    throw new AppError('SYNC_RESERVE_INVALID', 'Некоректний резерв товару', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO inventory_reserves (
        id, tenant_id, product_id, order_id, customer_id, qty, reserved_by,
        expires_at, released_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)
      ON CONFLICT (id) DO NOTHING`,
      [
        id,
        tenantId,
        payload.product_id,
        isUuid(payload.order_id) ? payload.order_id : null,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        qty,
        userId,
        payload.expires_at ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

async function applyReserveReleased(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const releasedAt = operation.payload?.released_at ?? operation.payload?.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE inventory_reserves
       SET released_at = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [operation.aggregate_id, tenantId, releasedAt, appliedAt],
    )
  })
}

async function applyWarehouseMovementCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  const qty = Number(payload.qty ?? 0)
  const toBin = String(payload.to_bin ?? '').trim()
  if (!isUuid(id) || !isUuid(payload.product_id) || qty <= 0 || !toBin) {
    throw new AppError('SYNC_WAREHOUSE_MOVEMENT_INVALID', 'Некоректне переміщення товару', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM warehouse_movements WHERE id = $1 AND tenant_id = $2', [id, tenantId])
    if (existing.rowCount) return
    const product = await client.query(
      'SELECT id, storage_bin FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [payload.product_id, tenantId],
    )
    if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Товар переміщення не знайдено', 404)
    await client.query(
      `INSERT INTO warehouse_movements (
        id, tenant_id, product_id, from_bin, to_bin, qty, moved_by, note, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id, tenantId, payload.product_id, payload.from_bin ?? product.rows[0]?.storage_bin ?? null,
        toBin, qty, userId, payload.note ?? null, createdAt, appliedAt,
      ],
    )
    await client.query(
      'UPDATE products SET storage_bin = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [payload.product_id, tenantId, toBin, appliedAt],
    )
  })
}

async function applyWriteoffCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const writeoffId = String(payload.id ?? operation.aggregate_id)
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(writeoffId) || items.length === 0) throw new AppError('SYNC_WRITEOFF_INVALID', 'Некоректне списання', 400)
  if (items.some((item: any) => !isUuid(item?.product_id) || !Number.isFinite(Number(item?.qty)) || Number(item.qty) <= 0)) {
    throw new AppError('SYNC_WRITEOFF_INVALID', 'Некоректна позиція списання', 422)
  }
  if (new Set(items.map((item: any) => item.product_id)).size !== items.length) {
    throw new AppError('SYNC_WRITEOFF_DUPLICATE', 'Один товар не можна списувати двома рядками', 422)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const claim = await client.query(
      `INSERT INTO inventory_writeoffs (id, tenant_id, reason, notes, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [writeoffId, tenantId, payload.reason ?? 'other', payload.notes ?? null, userId, createdAt, appliedAt],
    )
    if (!claim.rowCount) {
      const existing = await client.query(
        'SELECT id FROM inventory_writeoffs WHERE id = $1 AND tenant_id = $2',
        [writeoffId, tenantId],
      )
      if (existing.rowCount) return
      throw new AppError('SYNC_WRITEOFF_TENANT_CONFLICT', 'Акт списання належить іншому магазину', 409)
    }
    await client.query(`SELECT set_config('app.stock_source_type', 'writeoff', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [writeoffId])
    for (const item of items) {
      const product = await client.query(
        `SELECT purchase_price, COALESCE(qty_on_hand, 0) AS qty_on_hand
         FROM products
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [item.product_id, tenantId],
      )
      if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Товар списання не знайдено', 404)
      const qty = Number(item.qty)
      const available = Number(product.rows[0]?.qty_on_hand ?? 0)
      if (qty > available) {
        throw new AppError('INSUFFICIENT_STOCK', `Недостатньо товару для списання: є ${available}, потрібно ${qty}`, 409)
      }
      await client.query(
        `INSERT INTO inventory_writeoff_items (
          id, writeoff_id, product_id, qty, cost_kopecks, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), writeoffId, item.product_id, qty, Math.round(Number(product.rows[0]?.purchase_price ?? 0) * qty), createdAt],
      )
      await client.query(
        `UPDATE products
         SET qty_on_hand = qty_on_hand - $1, updated_at = $2
         WHERE id = $3 AND tenant_id = $4`,
        [qty, appliedAt, item.product_id, tenantId],
      )
    }
  })
}


async function applyReturnCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const returnId = String(payload.id ?? operation.aggregate_id)
  const saleId = String(payload.sale_id ?? '')
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(returnId) || !isUuid(saleId) || items.length === 0) {
    throw new AppError('SYNC_RETURN_INVALID', 'Некоректне повернення товару', 400)
  }

  const allowedReasons = new Set(['defective', 'wrong_part', 'changed_mind', 'customer_changed_mind', 'warranty', 'duplicate', 'other'])
  const allowedConditions = new Set(['good', 'defective', 'damaged', 'opened_packaging'])
  const allowedStockActions = new Set(['return_to_stock', 'write_off', 'send_to_supplier'])
  const reason = allowedReasons.has(String(payload.reason)) ? String(payload.reason) : 'other'
  const stockAction = allowedStockActions.has(String(payload.stock_action)) ? String(payload.stock_action) : 'return_to_stock'
  const requestedRefundMethod = payload.refund_method === 'card' ? 'terminal' : String(payload.refund_method ?? 'cash')
  const refundMethod = ['cash', 'terminal', 'debt_reduction', 'credit'].includes(requestedRefundMethod)
    ? requestedRefundMethod
    : 'cash'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  let returnShiftId = isUuid(payload.shift_id) ? payload.shift_id : null

  await runTransaction(async (client) => {
    await client.query("SELECT set_config('app.sync_mode', 'true', true)")
    const existing = await client.query(
      'SELECT id FROM returns WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [returnId, tenantId],
    )
    if (existing.rowCount) return

    const saleResult = await client.query(
      `SELECT id, sale_number, customer_id, shift_id, cashier_id, completed_at, payment_method, cash_amount, total
       FROM sales
       WHERE id = $1 AND tenant_id = $2 AND status IN ('completed', 'returned')
       FOR UPDATE`,
      [saleId, tenantId],
    )
    const sale = saleResult.rows[0]
    if (!sale) throw new AppError('SYNC_SALE_NOT_FOUND', 'Чек для повернення не знайдено', 404)

    const preparedItems: Array<{
      id: string
      saleItemId: string
      productId: string
      quantity: number
      unitPrice: number
      total: number
      condition: string
    }> = []

    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      const quantity = Number(item?.quantity ?? 0)
      if (!isUuid(productId) || !Number.isFinite(quantity) || quantity <= 0) {
        throw new AppError('SYNC_RETURN_ITEM_INVALID', 'Некоректна позиція повернення', 400)
      }
      const requestedSaleItemId = isUuid(item?.sale_item_id) ? item.sale_item_id : null
      const saleItemResult = await client.query(
        `SELECT si.id, si.product_id, si.qty, si.unit_price,
                COALESCE((
                  SELECT SUM(ri.quantity)
                  FROM return_items ri
                  JOIN returns r ON r.id = ri.return_id
                  WHERE ri.sale_item_id = si.id AND r.tenant_id = $2
                ), 0) AS returned_qty
         FROM sale_items si
         WHERE si.sale_id = $1
           AND si.tenant_id = $2
           AND si.product_id = $3
           AND ($4::uuid IS NULL OR si.id = $4 OR NOT EXISTS (
             SELECT 1 FROM sale_items exact_item WHERE exact_item.id = $4 AND exact_item.sale_id = $1
           ))
         ORDER BY CASE WHEN si.id = $4 THEN 0 ELSE 1 END, si.created_at ASC
         LIMIT 1
         FOR UPDATE OF si`,
        [saleId, tenantId, productId, requestedSaleItemId],
      )
      const saleItem = saleItemResult.rows[0]
      if (!saleItem) throw new AppError('SYNC_RETURN_ITEM_NOT_FOUND', 'Позицію чека для повернення не знайдено', 404)
      const available = Number(saleItem.qty ?? 0) - Number(saleItem.returned_qty ?? 0)
      if (quantity > available) {
        throw new AppError('SYNC_RETURN_QTY_INVALID', `Для товару доступно до повернення: ${Math.max(0, available)}`, 422)
      }
      const unitPrice = Math.round(Number(saleItem.unit_price ?? 0))
      const alreadyPrepared = preparedItems.find((prepared) => prepared.saleItemId === saleItem.id)
      if (alreadyPrepared) {
        if (alreadyPrepared.quantity + quantity > available) {
          throw new AppError('SYNC_RETURN_QTY_INVALID', 'Для товару доступно до повернення: ' + Math.max(0, available), 422)
        }
        alreadyPrepared.quantity += quantity
        alreadyPrepared.total = Math.round(alreadyPrepared.quantity * alreadyPrepared.unitPrice)
        continue
      }
      preparedItems.push({
        id: isUuid(item?.id) ? item.id : randomUUID(),
        saleItemId: saleItem.id,
        productId,
        quantity,
        unitPrice,
        total: Math.max(0, Math.round(quantity * unitPrice)),
        condition: allowedConditions.has(String(item?.condition)) ? String(item.condition) : 'good',
      })
    }

    const calculatedRefund = preparedItems.reduce((sum, item) => sum + item.total, 0)
    const refund = calculatedRefund
    await client.query(
      `INSERT INTO returns (
        id, tenant_id, sale_id, customer_id, return_type, reason, reason_text,
        reason_note, refund_amount, refund_kopecks, refund_method, stock_action,
        status, created_by, approved_by, fiscal_number, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,'customer_return',$5,$6,$6,$7,$7,$8,$9,
        'completed',$10,$10,$11,$12,$13
      )`,
      [
        returnId,
        tenantId,
        saleId,
        sale.customer_id ?? null,
        reason,
        payload.reason_note ?? null,
        refund,
        refundMethod,
        stockAction,
        uuidOr(payload.approved_by, userId),
        payload.fiscal_number ?? null,
        createdAt,
        appliedAt,
      ],
    )

    await client.query(`SELECT set_config('app.stock_source_type', 'return', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [returnId])
    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO return_items (
          id, tenant_id, return_id, product_id, sale_item_id, quantity,
          unit_price_kopecks, total_kopecks, condition, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          item.id, tenantId, returnId, item.productId, item.saleItemId,
          item.quantity, item.unitPrice, item.total, item.condition, createdAt,
        ],
      )
      if (stockAction === 'return_to_stock') {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [item.quantity, appliedAt, item.productId, tenantId],
        )
      }
    }

    if (refundMethod === 'cash' && refund > 0) {
      returnShiftId = returnShiftId ?? (isUuid(sale.shift_id) ? String(sale.shift_id) : null)
      let validShift: { rowCount: number | null; rows: Array<Record<string, any>> } = returnShiftId ? await client.query(
        `SELECT id FROM shifts
         WHERE id = $1 AND tenant_id = $2
           AND opened_at <= $3
           AND (closed_at IS NULL OR closed_at >= $3)
         LIMIT 1
         FOR UPDATE`,
        [returnShiftId, tenantId, createdAt],
      ) : { rowCount: 0, rows: [] }

      // Older desktop builds could keep selling after a locally open shift had already
      // closed on the server. Move that sale into a clearly marked reconciliation
      // shift instead of appending cash to a closed historical shift.
      if (!validShift.rowCount) {
        const reconciliationShiftId = randomUUID()
        const saleCash = sale.payment_method === 'cash'
          ? Math.max(0, Number(sale.cash_amount ?? sale.total ?? 0))
          : Math.max(0, Number(sale.cash_amount ?? 0))
        const openingCash = Math.max(0, refund - saleCash)
        const expectedCash = Math.max(0, openingCash + saleCash - refund)
        await client.query(
          `INSERT INTO shifts (
             id, tenant_id, cashier_id, status, opening_cash, closing_cash,
             expected_cash, cash_variance, opened_at, closed_at, notes, created_at, updated_at
           ) VALUES ($1,$2,$3,'closed',$4,$5,$5,0,LEAST($6::timestamptz,$7::timestamptz),$7,$8,LEAST($6::timestamptz,$7::timestamptz),$9)`,
          [
            reconciliationShiftId, tenantId, uuidOr(sale.cashier_id, userId),
            openingCash, expectedCash, sale.completed_at ?? createdAt, createdAt,
            'Автоматична звірка офлайн-продажу та повернення після закриття старої зміни',
            appliedAt,
          ],
        )
        await client.query(
          'UPDATE sales SET shift_id = $1, updated_at = $4 WHERE id = $2 AND tenant_id = $3',
          [reconciliationShiftId, saleId, tenantId, appliedAt],
        )
        returnShiftId = reconciliationShiftId
        validShift = { rowCount: 1, rows: [{ id: reconciliationShiftId }] }
      }

      const cashBalance = await client.query(
        `SELECT GREATEST(0,
           COALESCE(s.opening_cash, 0)
           + COALESCE((SELECT SUM(CASE
               WHEN sale.payment_method = 'cash' THEN COALESCE(NULLIF(sale.cash_amount, 0), sale.total)
               ELSE COALESCE(sale.cash_amount, 0)
             END)
             FROM sales sale
             WHERE sale.tenant_id = $2 AND sale.shift_id = s.id AND sale.status IN ('completed','returned')), 0)
           + COALESCE((SELECT SUM(CASE WHEN op.type = 'in' THEN op.amount ELSE -op.amount END)
             FROM cash_operations op WHERE op.tenant_id = $2 AND op.shift_id = s.id), 0)
         )::bigint AS available
         FROM shifts s WHERE s.id = $1 AND s.tenant_id = $2`,
        [returnShiftId, tenantId],
      )
      const availableCash = Number(cashBalance.rows[0]?.available ?? 0)
      if (availableCash < refund) {
        throw new AppError('CASHBOX_INSUFFICIENT_FUNDS', `У касі недостатньо готівки: доступно ${(availableCash / 100).toFixed(2)} грн`, 409)
      }
      await client.query(
        `INSERT INTO cash_operations (
          id, tenant_id, shift_id, type, amount, note, source, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,'out',$4,$5,'cashbox',$6,$7,$8)
        ON CONFLICT (id) DO NOTHING`,
        [
          returnId,
          tenantId,
          returnShiftId,
          refund,
          `Повернення за чеком ${sale.sale_number ?? saleId.slice(0, 8)}`,
          uuidOr(payload.approved_by, userId),
          createdAt,
          appliedAt,
        ],
      )
    } else if (sale.customer_id && refundMethod === 'debt_reduction' && refund > 0) {
      await client.query(
        `UPDATE customers
         SET debt_balance = GREATEST(0, COALESCE(debt_balance, 0) - $1), updated_at = $2
         WHERE id = $3 AND tenant_id = $4`,
        [refund, appliedAt, sale.customer_id, tenantId],
      )
    } else if (sale.customer_id && refundMethod === 'credit' && refund > 0) {
      const customerResult = await client.query(
        `UPDATE customers
         SET deposit_balance = COALESCE(deposit_balance, 0) + $1, updated_at = $2
         WHERE id = $3 AND tenant_id = $4
         RETURNING deposit_balance`,
        [refund, appliedAt, sale.customer_id, tenantId],
      )
      const balanceAfter = Number(customerResult.rows[0]?.deposit_balance ?? 0)
      await client.query(
        `INSERT INTO customer_deposit_transactions (
          id, tenant_id, customer_id, amount, balance_after, method, sale_id,
          shift_id, notes, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,'return_credit',$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING`,
        [
          returnId,
          tenantId,
          sale.customer_id,
          refund,
          balanceAfter,
          saleId,
          returnShiftId,
          `Повернення за чеком ${sale.sale_number ?? saleId.slice(0, 8)}`,
          uuidOr(payload.approved_by, userId),
          createdAt,
          appliedAt,
        ],
      )
    }

    const returnedOrderItems = await client.query(
      `WITH returned_by_item AS (
         SELECT ri.sale_item_id, SUM(ri.quantity) AS qty
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.sale_id = $1 AND r.tenant_id = $2
         GROUP BY ri.sale_item_id
       ), fully_returned_products AS (
         SELECT si.product_id
         FROM sale_items si
         LEFT JOIN returned_by_item returned ON returned.sale_item_id = si.id
         WHERE si.sale_id = $1 AND si.tenant_id = $2
         GROUP BY si.product_id
         HAVING COALESCE(SUM(returned.qty), 0) >= SUM(si.qty)
       )
       UPDATE customer_order_items coi
       SET item_status = 'returned'
       WHERE coi.order_id = (
         SELECT id FROM customer_orders
         WHERE sale_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1
       )
         AND coi.product_id IN (SELECT product_id FROM fully_returned_products)
         AND coi.item_status <> 'returned'
       RETURNING coi.id, coi.product_id`,
      [saleId, tenantId],
    )
    if (returnedOrderItems.rowCount) {
      const orderResult = await client.query(
        'SELECT id FROM customer_orders WHERE sale_id = $1 AND tenant_id = $2 LIMIT 1',
        [saleId, tenantId],
      )
      const orderId = orderResult.rows[0]?.id
      if (orderId) {
        await client.query(
          'UPDATE customer_orders SET updated_at = $3 WHERE id = $1 AND tenant_id = $2',
          [orderId, tenantId, appliedAt],
        )
        await client.query(
          `INSERT INTO order_activity_log (order_id, user_id, action, details)
           VALUES ($1,$2,'items_returned',$3::jsonb)`,
          [orderId, userId, JSON.stringify({
            return_id: returnId,
            product_ids: returnedOrderItems.rows.map((row) => row.product_id),
          })],
        )
      }
    }

    const remainingResult = await client.query(
      `SELECT COALESCE(SUM(GREATEST(si.qty - COALESCE(returned.qty, 0), 0)), 0) AS remaining
       FROM sale_items si
       LEFT JOIN (
         SELECT ri.sale_item_id, SUM(ri.quantity) AS qty
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.sale_id = $1 AND r.tenant_id = $2
         GROUP BY ri.sale_item_id
       ) returned ON returned.sale_item_id = si.id
       WHERE si.sale_id = $1 AND si.tenant_id = $2`,
      [saleId, tenantId],
    )
    if (Number(remainingResult.rows[0]?.remaining ?? 0) <= 0) {
      await client.query(
        "UPDATE sales SET status = 'returned', updated_at = $3 WHERE id = $1 AND tenant_id = $2",
        [saleId, tenantId, appliedAt],
      )
    }
  })

  const { data: storedReturnItems, error: storedReturnItemsError } = await db
    .from('return_items')
    .select('product_id, quantity, sale_item_id')
    .eq('return_id', returnId)
    .eq('tenant_id', tenantId)
  if (storedReturnItemsError) {
    throw new AppError('SYNC_RETURN_COMMISSION_ITEMS_FAILED', 'Не вдалося прочитати позиції повернення для сторно комісії', 500)
  }
  const { reverseCommissionForReturn } = await import('./commissionService.js')
  await reverseCommissionForReturn(
    returnId,
    saleId,
    (storedReturnItems ?? []).map((item) => ({
      product_id: item.product_id,
      quantity: Number(item.quantity),
      sale_item_id: item.sale_item_id,
    })),
    tenantId,
    userId,
  )
}

async function applySuspendedSale(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const saleId = String(payload.id ?? operation.aggregate_id)
  const shiftId = String(payload.shift_id ?? '')
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(saleId) || !isUuid(shiftId) || items.length === 0) {
    throw new AppError('SYNC_SUSPENDED_SALE_INVALID', 'Некоректний відкладений чек', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM sales WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [saleId, tenantId],
    )
    if (existing.rowCount) return

    const cashierId = uuidOr(payload.cashier_id ?? payload.manager_id, userId)
    const shift = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [shiftId, tenantId],
    )
    if (!shift.rowCount) {
      await client.query(
        `INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
        ) VALUES ($1,$2,$3,'open',0,$4,$5,$4,$6)`,
        [shiftId, tenantId, cashierId, createdAt, 'Створено під час офлайн-синхронізації', appliedAt],
      )
    }

    const subtotal = Math.max(0, Math.round(Number(payload.subtotal ?? 0)))
    const total = Math.max(0, Math.round(Number(payload.total ?? subtotal)))
    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, pickup_cell, completed_at, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'suspended',
        $7,0,$8,$9,false,$10,$11,
        0,0,$12,$13,$13,$14
      )`,
      [
        saleId,
        tenantId,
        payload.sale_number ?? `S-${saleId.slice(0, 8)}`,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        cashierId,
        shiftId,
        subtotal,
        total,
        normalizePaymentMethod(payload.payment_method),
        payload.notes ?? null,
        uuidOr(payload.manager_id, cashierId),
        payload.pickup_cell ?? null,
        createdAt,
        appliedAt,
      ],
    )

    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      const qty = Number(item?.qty ?? 0)
      if (!isUuid(productId) || !Number.isFinite(qty) || qty <= 0) continue
      const product = await client.query(
        'SELECT purchase_price FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
        [productId, tenantId],
      )
      if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар не знайдено: ${productId}`, 404)
      const unitPrice = Math.max(0, Math.round(Number(item?.unit_price ?? 0)))
      const discount = Math.max(0, Math.round(Number(item?.discount ?? 0)))
      const lineTotal = Math.max(0, Math.round(Number(item?.total ?? qty * unitPrice - discount)))
      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          isUuid(item?.id) ? item.id : randomUUID(),
          tenantId,
          saleId,
          productId,
          qty,
          unitPrice,
          discount,
          lineTotal,
          Math.max(0, Math.round(Number(item?.purchase_price ?? product.rows[0].purchase_price ?? 0))),
        ],
      )
    }
  })
}

async function applySuspendedSaleClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    await client.query(
      "UPDATE sales SET status = 'cancelled', updated_at = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'suspended'",
      [operation.aggregate_id, tenantId, operation.applied_at ?? operation.created_at],
    )
  })
}


async function applySupplierInvoiceCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const invoiceId = String(payload.id || operation.aggregate_id)
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) throw new AppError('SYNC_INVOICE_EMPTY', 'У накладній немає товарів', 422)
  let total: number
  let requestedPaidAmount: number
  try {
    total = checkedSyncMoney(
      items.reduce((sum: number, item: any) => sum + invoiceLineTotal(item), 0),
      'Сума накладної',
    )
    requestedPaidAmount = checkedSyncMoney(payload.paid_amount ?? 0, 'Сума оплати')
  } catch (error: any) {
    throw new AppError('SYNC_INVOICE_AMOUNT_INVALID', error?.message ?? 'Некоректна сума накладної', 422)
  }
  const paidAmount = Math.min(requestedPaidAmount, total)
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM supply_invoices WHERE id = $1 AND tenant_id = $2 LIMIT 1', [invoiceId, tenantId])
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO supply_invoices (
        id, tenant_id, supplier_id, invoice_number, status, total, paid_amount,
        payment_method, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10)`,
      [invoiceId, tenantId, payload.supplier_id ?? null, payload.invoice_number ?? null, total, paidAmount, paidAmount > 0 ? (payload.payment_method ?? 'cash') : null, payload.notes ?? null, createdAt, appliedAt],
    )

    for (const item of items) {
      await client.query(
        `INSERT INTO supply_invoice_items (id, tenant_id, invoice_id, product_id, qty, purchase_price, total, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [item.id ?? randomUUID(), tenantId, invoiceId, item.product_id, Number(item.qty ?? 0), Number(item.purchase_price ?? 0), invoiceLineTotal(item), createdAt],
      )
    }

    if (paidAmount > 0) {
      const paymentId = payload.payment_id ?? randomUUID()
      const method = payload.payment_method ?? 'cash'
      const fundSource = payload.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
      if (fundSource === 'cashbox') {
        if (!isUuid(payload.shift_id)) throw new AppError('SHIFT_REQUIRED', 'Щоб платити з каси, потрібна відкрита касова зміна', 409)
        await assertSyncCashboxHasFunds(client, tenantId, payload.shift_id, paidAmount, createdAt)
      }
      await client.query(
        `INSERT INTO supplier_payments
         (id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [paymentId, tenantId, invoiceId, payload.supplier_id ?? null, paidAmount, method, fundSource, payload.shift_id ?? null, 'Оплата під час створення накладної', userId, createdAt, appliedAt],
      )
      if (fundSource === 'cashbox') {
        await client.query(
          `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, source, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,'out',$4,$5,'cashbox',$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [paymentId, tenantId, payload.shift_id, paidAmount, 'Оплата постачальнику під час створення накладної', userId, createdAt, appliedAt],
        )
      }
    }
  })
}

async function applySupplierInvoiceUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const hasItems = Array.isArray(payload.items)
  const items = hasItems ? payload.items : []
  const total = hasItems
    ? items.reduce((sum: number, item: any) => sum + invoiceLineTotal(item), 0)
    : Math.max(0, Math.round(Number(payload.total ?? 0)))
  const timestamp = operation.applied_at ?? operation.created_at ?? new Date().toISOString()

  await runTransaction(async (client) => {
    const invoice = await client.query(
      'SELECT status, supplier_id, invoice_number, notes, total FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [operation.aggregate_id, tenantId],
    )
    if (!invoice.rowCount) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    if (invoice.rows[0].status !== 'draft') throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)

    await client.query(
      `UPDATE supply_invoices
       SET supplier_id = $1, invoice_number = $2, notes = $3, total = $4,
           draft_payload = NULL, draft_saved_at = NULL, draft_saved_by = NULL,
           updated_at = $5
       WHERE id = $6 AND tenant_id = $7`,
      [
        Object.prototype.hasOwnProperty.call(payload, 'supplier_id') ? payload.supplier_id ?? null : invoice.rows[0].supplier_id ?? null,
        Object.prototype.hasOwnProperty.call(payload, 'invoice_number') ? payload.invoice_number ?? null : invoice.rows[0].invoice_number ?? null,
        Object.prototype.hasOwnProperty.call(payload, 'notes') ? payload.notes ?? null : invoice.rows[0].notes ?? null,
        hasItems ? total : Number(invoice.rows[0].total ?? 0),
        timestamp,
        operation.aggregate_id,
        tenantId,
      ],
    )

    if (hasItems) {
      if (items.length === 0) throw new AppError('SYNC_INVOICE_EMPTY', 'У накладній немає товарів', 422)
      await client.query('DELETE FROM supply_invoice_items WHERE invoice_id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
      for (const item of items) {
        await client.query(
          `INSERT INTO supply_invoice_items (id, tenant_id, invoice_id, product_id, qty, purchase_price, total, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            item.id ?? randomUUID(),
            tenantId,
            operation.aggregate_id,
            item.product_id,
            Number(item.qty ?? 0),
            Number(item.purchase_price ?? 0),
            invoiceLineTotal(item),
            timestamp,
          ],
        )
      }
    }
  })
}
async function applySupplierInvoicePosted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: invoice } = await db
    .from('supply_invoices')
    .select('id,status')
    .eq('id', operation.aggregate_id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
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
  let amount: number
  try {
    amount = checkedSyncMoney(payload.amount ?? 0, 'Сума оплати')
  } catch (error: any) {
    throw new AppError('INVALID_AMOUNT', error?.message ?? 'Некоректна сума оплати', 422)
  }
  if (amount <= 0) throw new AppError('INVALID_AMOUNT', 'Сума оплати має бути більше нуля', 422)
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM supplier_payments WHERE id = $1 LIMIT 1', [paymentId])
    if (existing.rowCount && existing.rowCount > 0) return
    const invoiceResult = await client.query(
      `SELECT id, supplier_id, total, COALESCE(paid_amount, 0) AS paid_amount
       FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    const invoice = invoiceResult.rows[0]
    if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    const remaining = Number(invoice.total) - Number(invoice.paid_amount)
    if (amount > remaining) throw new AppError('PAYMENT_TOO_LARGE', 'Сума перевищує борг за накладною', 422)
    const method = payload.payment_method ?? 'cash'
    const fundSource = payload.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
    if (fundSource === 'cashbox') {
      if (!isUuid(payload.shift_id)) {
        throw new AppError('SHIFT_REQUIRED', 'Щоб платити з каси, потрібна відкрита касова зміна', 409)
      }
      await assertSyncCashboxHasFunds(client, tenantId, payload.shift_id, amount, createdAt)
    }
    await client.query(
      `INSERT INTO supplier_payments
       (id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [paymentId, tenantId, operation.aggregate_id, invoice.supplier_id, amount, method, fundSource, payload.shift_id ?? null, payload.note ?? null, userId, createdAt, appliedAt],
    )
    await client.query(
      'UPDATE supply_invoices SET paid_amount = COALESCE(paid_amount, 0) + $1, payment_method = $2, updated_at = $5 WHERE id = $3 AND tenant_id = $4',
      [amount, method, operation.aggregate_id, tenantId, appliedAt],
    )
    if (fundSource === 'cashbox') {
      await client.query(
        `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, source, created_at, updated_at)
         VALUES ($1,$2,$3,'out',$4,$5,$6,'cashbox',$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [paymentId, tenantId, payload.shift_id, amount, payload.note || 'Оплата постачальнику', userId, createdAt, appliedAt],
      )
    }
  })
}

async function applySupplierInvoiceCancelled(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: invoice } = await db
    .from('supply_invoices')
    .select('id,status,paid_amount')
    .eq('id', operation.aggregate_id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()
  if (!invoice) return
  if (invoice.status === 'cancelled') return
  if (Number(invoice.paid_amount ?? 0) > 0) {
    throw new AppError('PAID_INVOICE_CANNOT_BE_CANCELLED', 'Не можна скасувати оплачену накладну', 409)
  }
  const { error } = await db.rpc('cancel_supply_invoice', { p_invoice_id: operation.aggregate_id })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

async function applySupplierInvoiceDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    const invoiceResult = await client.query('SELECT status, paid_amount, deleted_at FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE', [operation.aggregate_id, tenantId])
    const invoice = invoiceResult.rows[0]
    if (!invoice || invoice.deleted_at) return
    if (invoice.status !== 'draft' || Number(invoice.paid_amount ?? 0) > 0) {
      throw new AppError('INVOICE_DELETE_FORBIDDEN', 'Видалити можна лише неоплачену чернетку накладної', 409)
    }
    await client.query(
      `UPDATE supply_invoices
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, operation.created_at],
    )
  })
}
async function applyShiftOpened(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const createdAt = payload.created_at ?? operation.created_at
  const openedAt = payload.opened_at ?? createdAt
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId],
    )
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)`,
      [
        operation.aggregate_id,
        tenantId,
        payload.cashier_id,
        Number(payload.opening_cash ?? 0),
        openedAt,
        payload.notes ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

async function applyShiftClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const closedAt = payload.closed_at ?? payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const result = await client.query(
      `UPDATE shifts
       SET status = 'closed', closing_cash = $3, expected_cash = $4,
           cash_variance = $5, closed_at = $6, notes = COALESCE($7, notes), updated_at = $8
       WHERE id = $1 AND tenant_id = $2`,
      [
        operation.aggregate_id,
        tenantId,
        Number(payload.closing_cash ?? 0),
        Number(payload.expected_cash ?? 0),
        Number(payload.cash_variance ?? 0),
        closedAt,
        payload.notes ?? null,
        appliedAt,
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
    const saleId = String(payload.sale_id ?? operation.aggregate_id)
    const existing = await client.query(
      'SELECT id FROM sales WHERE id = $1 AND tenant_id = $2',
      [saleId, tenantId],
    )
    if (existing.rowCount) return

    const payments = Array.isArray(payload.payments) ? payload.payments : []
    const cashAmount = sumPayments(payments, 'cash')
    const cardAmount = sumPayments(payments, 'card')
    const transferAmount = sumPayments(payments, 'transfer')
    const debtAmount = sumPayments(payments, 'debt')
    const paymentMethod = normalizePaymentMethod(payload.payment_method)
    const completedAt = payload.completed_at ?? operation.created_at
    const appliedAt = operation.applied_at ?? operation.created_at
    let shiftId = isUuid(payload.shift_id) ? String(payload.shift_id) : null
    if (!shiftId) throw new AppError('SYNC_SALE_SHIFT_REQUIRED', 'Для продажу не вказано касову зміну', 422)
    const shift = await client.query(
      'SELECT id, status, opened_at, closed_at FROM shifts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [shiftId, tenantId],
    )
    if (!shift.rowCount) {
      await client.query(
        `INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
        ) VALUES ($1, $2, $3, 'open', 0, $4, $5, $4, $6)`,
        [shiftId, tenantId, uuidOr(payload.cashier_id, userId), completedAt, 'Створено під час офлайн-синхронізації', appliedAt],
      )
    } else {
      const row = shift.rows[0]
      const completedTime = new Date(completedAt).getTime()
      const outsideInterval = completedTime < new Date(row.opened_at).getTime()
        || (row.closed_at && completedTime > new Date(row.closed_at).getTime())
      if (outsideInterval) {
        shiftId = randomUUID()
        const expectedCash = Math.max(0, cashAmount)
        await client.query(
          `INSERT INTO shifts (
             id, tenant_id, cashier_id, status, opening_cash, closing_cash,
             expected_cash, cash_variance, opened_at, closed_at, notes, created_at, updated_at
           ) VALUES ($1,$2,$3,'closed',0,$4,$4,0,$5,$5,$6,$5,$7)`,
          [
            shiftId, tenantId, uuidOr(payload.cashier_id, userId), expectedCash, completedAt,
            'Автоматична звірка офлайн-продажу після закриття старої зміни',
            appliedAt,
          ],
        )
      }
    }
    const bonusesSpent = Math.max(0, Math.round(Number(payload.bonuses_spent ?? 0)))
    const fiscalNumber = payload.fiscal_number
      ?? payments.find((payment: { fiscal_number?: string | null }) => payment?.fiscal_number)?.fiscal_number
      ?? null
    const isFiscal = payload.is_fiscal === true || fiscalNumber !== null

    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, transfer_amount, bonuses_spent, is_fiscal, fiscal_number, fiscal_qr_url,
        completed_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'completed',
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20,
        $21, $21, $22
      )`,
      [
        saleId,
        tenantId,
        payload.sale_number,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        uuidOr(payload.cashier_id, userId),
        shiftId,
        Number(payload.subtotal ?? 0),
        Number(payload.discount ?? 0),
        Number(payload.total ?? 0),
        paymentMethod,
        debtAmount > 0 || paymentMethod === 'debt',
        payload.notes ?? null,
        uuidOr(payload.manager_id ?? payload.cashier_id, userId),
        cashAmount,
        cardAmount,
        transferAmount,
        bonusesSpent,
        isFiscal,
        fiscalNumber,
        payload.fiscal_qr_url ?? null,
        completedAt,
        appliedAt,
      ],
    )

    await client.query(`SELECT set_config('app.stock_source_type', 'sale', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [saleId])
    for (const item of payload.items ?? []) {
      const productId = item.product_id ?? await ensureFreeAmountProduct(client, tenantId)
      const product = await client.query(
        `SELECT id, is_service, COALESCE(purchase_price, 0) AS purchase_price,
                requires_core_return, COALESCE(core_deposit_amount, 0) AS core_deposit_amount
         FROM products
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [productId, tenantId],
      )
      if (!product.rowCount) {
        throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар не знайдено: ${productId}`, 404)
      }

      const qty = Number(item.qty ?? 0)
      if (!Number.isFinite(qty) || qty <= 0) throw new AppError('SYNC_SALE_QTY_INVALID', 'Кількість товару у чеку має бути більше нуля', 422)
      const unitPrice = Math.max(0, Math.round(Number(item.unit_price ?? 0)))
      const discount = Math.max(0, Math.round(Number(item.discount ?? 0)))
      const total = Math.max(0, Math.round(qty * unitPrice - discount))
      const isService = product.rows[0].is_service === true
      const costPrice = Number(item.purchase_price ?? product.rows[0].purchase_price ?? 0)
      const coreDepositAmount = product.rows[0].requires_core_return === true
        ? Number(product.rows[0].core_deposit_amount ?? 0)
        : 0

      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total,
          cost_price, core_deposit_amount, core_return_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          isUuid(item.id) ? item.id : randomUUID(),
          tenantId,
          saleId,
          productId,
          qty,
          unitPrice,
          discount,
          total,
          costPrice,
          coreDepositAmount,
          coreDepositAmount > 0 ? 'pending' : 'none',
        ],
      )

      if (!isService) {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [qty, appliedAt, productId, tenantId],
        )
      }
    }

    const customerId = isUuid(payload.customer_id) ? payload.customer_id : null
    if (debtAmount > 0 && customerId) {
      await client.query(
        'UPDATE customers SET debt_balance = debt_balance + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
        [debtAmount, appliedAt, customerId, tenantId],
      )
    } else if (paymentMethod === 'debt' && customerId) {
      await client.query(
        'UPDATE customers SET debt_balance = debt_balance + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
        [Number(payload.total ?? 0), appliedAt, customerId, tenantId],
      )
    }

    if (bonusesSpent > 0) {
      if (!customerId) throw new AppError('SYNC_BONUS_CUSTOMER_REQUIRED', 'Для списання бонусів потрібен клієнт', 422)
      const spent = await client.query(
        `UPDATE customers
         SET bonus_balance = COALESCE(bonus_balance, 0) - $1, updated_at = $2
         WHERE id = $3 AND tenant_id = $4 AND COALESCE(bonus_balance, 0) >= $1
         RETURNING bonus_balance`,
        [bonusesSpent, appliedAt, customerId, tenantId],
      )
      if (!spent.rowCount) {
        throw new AppError('SYNC_INSUFFICIENT_BONUS', 'На сервері недостатньо бонусів клієнта; спочатку синхронізуйте картку клієнта', 409)
      }
      await client.query(
        `INSERT INTO bonus_transactions (
          id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
          description, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,'spend',$5,$6,$7,$8)`,
        [
          operation.operation_id,
          tenantId,
          customerId,
          -bonusesSpent,
          saleId,
          `Списання бонусів за чеком ${payload.sale_number ?? saleId.slice(0, 8)}`,
          completedAt,
          appliedAt,
        ],
      )
    }
  })
}

async function applyPricingSettingsOperations(
  tenantId: string,
  operation: SyncOutboxOperation,
): Promise<void> {
  const payload = operation.payload ?? {}
  const tierUpserts = Array.isArray(payload.price_tier_upserts) ? payload.price_tier_upserts : []
  const tierDeletedIds = Array.isArray(payload.price_tier_deleted_ids) ? payload.price_tier_deleted_ids : []
  const markupUpserts = Array.isArray(payload.category_markup_upserts) ? payload.category_markup_upserts : []
  const markupDeletedIds = Array.isArray(payload.category_markup_deleted_ids) ? payload.category_markup_deleted_ids : []
  if (tierUpserts.length + tierDeletedIds.length + markupUpserts.length + markupDeletedIds.length === 0) return

  await runTransaction(async (client) => {
    for (const value of tierUpserts) {
      const row = value && typeof value === 'object' ? value as Record<string, any> : {}
      let id = String(row.id ?? '')
      const name = String(row.name ?? '').trim()
      const discountPct = Number(row.discount_pct ?? 0)
      const sortOrder = Math.trunc(Number(row.sort_order ?? 0))
      if (id === 'default') {
        const defaultTier = await client.query(
          'SELECT id FROM price_tiers WHERE tenant_id = $1 AND is_default = true ORDER BY sort_order ASC LIMIT 1',
          [tenantId],
        )
        id = defaultTier.rows[0]?.id ?? randomUUID()
      }
      if (!isUuid(id) || !name || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
        throw new AppError('SYNC_PRICE_TIER_INVALID', 'Некоректний рівень ціни', 400)
      }
      if (row.is_default === true) {
        await client.query('UPDATE price_tiers SET is_default = false WHERE tenant_id = $1', [tenantId])
      }
      await client.query(
        `INSERT INTO price_tiers (id, tenant_id, name, discount_pct, is_default, sort_order, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           discount_pct = EXCLUDED.discount_pct,
           is_default = EXCLUDED.is_default,
           sort_order = EXCLUDED.sort_order
         WHERE price_tiers.tenant_id = EXCLUDED.tenant_id`,
        [id, tenantId, name, discountPct, row.is_default === true, sortOrder, row.created_at ?? operation.created_at],
      )
    }

    for (const value of tierDeletedIds) {
      const id = String(value ?? '')
      if (!isUuid(id)) throw new AppError('SYNC_PRICE_TIER_INVALID', 'Некоректний рівень ціни', 400)
      await client.query(
        'UPDATE customers SET price_tier_id = NULL, updated_at = $3 WHERE tenant_id = $1 AND price_tier_id = $2',
        [tenantId, id, operation.created_at],
      )
      await client.query(
        'UPDATE volume_discounts SET price_tier_id = NULL WHERE tenant_id = $1 AND price_tier_id = $2',
        [tenantId, id],
      )
      await client.query('DELETE FROM price_tiers WHERE id = $1 AND tenant_id = $2 AND is_default = false', [id, tenantId])
    }

    for (const value of markupUpserts) {
      const row = value && typeof value === 'object' ? value as Record<string, any> : {}
      const categoryId = String(row.category_id ?? '')
      const markupPct = Number(row.markup_pct ?? 0)
      const minMarkupPct = Number(row.min_markup_pct ?? 0)
      if (!isUuid(categoryId) || !Number.isFinite(markupPct) || markupPct < 0 || markupPct > 10000
        || !Number.isFinite(minMarkupPct) || minMarkupPct < 0 || minMarkupPct > 10000) {
        throw new AppError('SYNC_CATEGORY_MARKUP_INVALID', 'Некоректна націнка категорії', 400)
      }
      const category = await client.query('SELECT id FROM categories WHERE id = $1 AND tenant_id = $2', [categoryId, tenantId])
      if (!category.rowCount) throw new AppError('SYNC_CATEGORY_NOT_FOUND', 'Категорію для націнки не знайдено', 404)
      await client.query(
        `INSERT INTO category_markups (id, tenant_id, category_id, markup_pct, min_markup_pct, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, category_id) DO UPDATE SET
           markup_pct = EXCLUDED.markup_pct,
           min_markup_pct = EXCLUDED.min_markup_pct`,
        [isUuid(row.id) ? row.id : randomUUID(), tenantId, categoryId, markupPct, minMarkupPct, row.created_at ?? operation.created_at],
      )
    }

    for (const value of markupDeletedIds) {
      const categoryId = String(value ?? '')
      if (!isUuid(categoryId)) throw new AppError('SYNC_CATEGORY_MARKUP_INVALID', 'Некоректна націнка категорії', 400)
      await client.query('DELETE FROM category_markups WHERE tenant_id = $1 AND category_id = $2', [tenantId, categoryId])
    }
  })
}
async function applySettingsUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await applyPricingSettingsOperations(tenantId, operation)
  const requestedUpdates = pickShopSettingsPayload(operation.payload ?? {})
  const hasLabelSettings = requestedUpdates.label_settings !== undefined
  const maxAttempts = hasLabelSettings ? 3 : 1
  const originalOperationCreatedAt = typeof operation.payload?.created_at === 'string'
    ? operation.payload.created_at
    : operation.created_at
  const serverReceivedAt = new Date().toISOString()

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const updates = { ...requestedUpdates }
    let expectedUpdatedAt: string | null | undefined

    if (hasLabelSettings) {
      const { data: current, error: currentError } = await db
        .from('shop_settings')
        .select('label_settings,updated_at')
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (currentError) throw new AppError('DB_ERROR', currentError.message, 500)

      expectedUpdatedAt = current?.updated_at
      const prepared = prepareLabelSettingsUpdate({
        incoming: requestedUpdates.label_settings,
        // pushLocalOperations records the server apply time in operation.created_at,
        // while payload.created_at preserves when the offline edit was actually made.
        incomingFallbackUpdatedAt: originalOperationCreatedAt,
        current: current?.label_settings,
        currentRowUpdatedAt: current?.updated_at,
        serverReceivedAt,
      })
      if (prepared.shouldApply && prepared.normalizedIncoming) {
        updates.label_settings = prepared.normalizedIncoming
      } else {
        delete updates.label_settings
      }
    }

    if (Object.keys(updates).length === 0) return
    let query = db
      .from('shop_settings')
      // Час рядка — момент застосування на сервері. Старий offline created_at не
      // повинен відкотити sync-cursor назад і приховати зміни від інших пристроїв.
      .update({
        ...updates,
        updated_at: nextSettingsRowUpdatedAt(expectedUpdatedAt, new Date(serverReceivedAt)),
      })
      .eq('tenant_id', tenantId)
    if (hasLabelSettings) {
      query = expectedUpdatedAt == null
        ? query.is('updated_at', null)
        : query.eq('updated_at', expectedUpdatedAt)
    }
    const { data, error } = await query.select('tenant_id').maybeSingle()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    if (data) return
    // Інший пристрій встиг зберегти налаштування: перечитуємо і порівнюємо знову.
  }

  throw new AppError(
    'SETTINGS_CONFLICT',
    'Макет етикетки одночасно змінено на іншому пристрої. Синхронізацію буде повторено.',
    409,
  )
}

async function applyCategoryUpsert(tenantId: string, operation: SyncOutboxOperation, role: string): Promise<void> {
  const payload = operation.payload ?? {}
  const categoryId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(categoryId) || !name) {
    throw new AppError('SYNC_CATEGORY_INVALID', 'Категорія має містити коректні id і назву', 400)
  }
  const parentId = isUuid(payload.parent_id) && payload.parent_id !== categoryId ? payload.parent_id : null
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    if (!['owner', 'admin'].includes(role)) {
      const existing = await client.query(
        'SELECT id FROM categories WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
        [categoryId, tenantId],
      )
      if (existing.rowCount) {
        throw new AppError('FORBIDDEN', 'Змінювати існуючі категорії може тільки власник або адміністратор', 403)
      }
    }
    await client.query(
      `INSERT INTO categories (
         id, tenant_id, parent_id, name, sort_order, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (id) DO UPDATE SET
         parent_id = EXCLUDED.parent_id,
         name = EXCLUDED.name,
         sort_order = EXCLUDED.sort_order,
         updated_at = EXCLUDED.updated_at,
         deleted_at = NULL
       WHERE categories.tenant_id = EXCLUDED.tenant_id`,
      [categoryId, tenantId, parentId, name, Number(payload.sort_order ?? 0), createdAt, appliedAt],
    )
  })
}
async function applyCategoryDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET category_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND category_id = $2`,
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      `UPDATE categories SET parent_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND parent_id = $2 AND deleted_at IS NULL`,
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      'UPDATE volume_discounts SET category_id = NULL WHERE tenant_id = $1 AND category_id = $2',
      [tenantId, operation.aggregate_id],
    )
    await client.query(
      'DELETE FROM category_markups WHERE tenant_id = $1 AND category_id = $2',
      [tenantId, operation.aggregate_id],
    )
    await client.query(
      'UPDATE commission_rules SET category_id = NULL, updated_at = $3 WHERE tenant_id = $1 AND category_id = $2',
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      `UPDATE categories
       SET parent_id = NULL, deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}
async function applyBrandUpsert(tenantId: string, operation: SyncOutboxOperation, role: string): Promise<void> {
  const payload = operation.payload ?? {}
  const brandId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(brandId) || !name) {
    throw new AppError('SYNC_BRAND_INVALID', 'Бренд має містити коректні id і назву', 400)
  }
  const tier = ['original', 'premium', 'standard', 'budget'].includes(String(payload.tier))
    ? String(payload.tier)
    : 'standard'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    if (!['owner', 'admin'].includes(role)) {
      const existing = await client.query(
        'SELECT id FROM brands WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
        [brandId, tenantId],
      )
      if (existing.rowCount) {
        throw new AppError('FORBIDDEN', 'Змінювати існуючі бренди може тільки власник або адміністратор', 403)
      }
    }
    await client.query(
      `INSERT INTO brands (
         id, tenant_id, name, country, tier, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         country = EXCLUDED.country,
         tier = EXCLUDED.tier,
         updated_at = EXCLUDED.updated_at,
         deleted_at = NULL
       WHERE brands.tenant_id = EXCLUDED.tenant_id`,
      [brandId, tenantId, name, payload.country ?? null, tier, createdAt, appliedAt],
    )
  })
}
async function applyBrandDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET brand_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND brand_id = $2 AND deleted_at IS NULL`,
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      'UPDATE commission_rules SET brand_id = NULL, updated_at = $3 WHERE tenant_id = $1 AND brand_id = $2',
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      `UPDATE brands
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}


async function applyProductUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const productId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(productId)) {
    throw new AppError('SYNC_PRODUCT_INVALID', 'Товар має містити коректний id', 400)
  }

  await runTransaction(async (client) => {
    const existingResult = await client.query(
      `SELECT id, sku, name, barcode, brand_id, category_id, unit,
              purchase_price, retail_price, qty_on_hand, reorder_point, notes,
              is_active, is_service, requires_core_return, core_deposit_amount,
              storage_bin, is_favorite, photo_url, specs, additional_barcodes
       FROM products
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [productId, tenantId],
    )
    const existing = existingResult.rows[0] ?? null
    const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key)
    const fromPayload = (key: string, fallback: any): any => owns(key) ? payload[key] : fallback
    const toNumber = (value: any, fallback = 0): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const toMoney = (value: any, fallback: number, field: string): number => {
      const parsed = Math.round(toNumber(value, fallback))
      if (parsed < 0 || parsed > 2_147_483_647) {
        throw new AppError('SYNC_PRODUCT_PRICE_INVALID', `${field} має містити коректну суму`, 422)
      }
      return parsed
    }

    const sku = String(fromPayload('sku', existing?.sku ?? '') ?? '').trim()
    const name = String(fromPayload('name', existing?.name ?? '') ?? '').trim()
    if (!sku || !name) {
      throw new AppError('SYNC_PRODUCT_INVALID', 'Новий товар має містити артикул і назву', 400)
    }

    const barcodesTouched = owns('barcode') || owns('additional_barcodes')
    const currentBarcodeRows = barcodesTouched && existing
      ? (await client.query(
        `SELECT barcode, is_primary
         FROM product_barcodes
         WHERE tenant_id = $1 AND product_id = $2
         ORDER BY is_primary DESC, created_at ASC`,
        [tenantId, productId],
      )).rows
      : []
    const currentAdditional = [
      ...(Array.isArray(existing?.additional_barcodes) ? existing.additional_barcodes : []),
      ...currentBarcodeRows.filter((row: any) => row.is_primary !== true).map((row: any) => row.barcode),
    ]
    const primaryBarcodeValue = fromPayload('barcode', existing?.barcode ?? null)
    const primaryBarcode = typeof primaryBarcodeValue === 'string' && primaryBarcodeValue.trim()
      ? primaryBarcodeValue.trim()
      : null
    const requestedAdditional = owns('additional_barcodes')
      ? (Array.isArray(payload.additional_barcodes) ? payload.additional_barcodes : [])
      : currentAdditional
    const additionalBarcodes = [...new Set(requestedAdditional
      .filter((barcode: any): barcode is string => typeof barcode === 'string' && barcode.trim().length > 0)
      .map((barcode: string) => barcode.trim())
      .filter((barcode: string) => barcode !== primaryBarcode))]
    const barcodes = [...new Set([primaryBarcode, ...additionalBarcodes].filter((barcode): barcode is string => Boolean(barcode)))]

    const requestedPhotoUrl = fromPayload('photo_url', existing?.photo_url ?? null)
    const photoUrl = typeof requestedPhotoUrl === 'string' && /^file:/i.test(requestedPhotoUrl)
      ? existing?.photo_url ?? null
      : requestedPhotoUrl

    const updatedAt = operation.applied_at ?? operation.created_at
    const brandId = fromPayload('brand_id', existing?.brand_id ?? null) || null
    const categoryId = fromPayload('category_id', existing?.category_id ?? null) || null
    // A missing reference used to surface as a raw `products_brand_id_fkey`
    // violation, which says nothing to the cashier watching the queue and hides
    // the fact that the fix is simply to let the brand through first. The
    // reference always precedes the product in the outbox, so retrying works.
    await assertProductReferenceExists(client, tenantId, 'brands', brandId, 'Бренд')
    await assertProductReferenceExists(client, tenantId, 'categories', categoryId, 'Категорію')
    const productValues = [
      productId,
      tenantId,
      sku,
      name,
      primaryBarcode,
      brandId,
      categoryId,
      String(fromPayload('unit', existing?.unit ?? 'шт') ?? 'шт'),
      toMoney(fromPayload('purchase_price', existing?.purchase_price ?? 0), Number(existing?.purchase_price ?? 0), 'Ціна закупівлі'),
      toMoney(fromPayload('retail_price', existing?.retail_price ?? 0), Number(existing?.retail_price ?? 0), 'Ціна продажу'),
      toNumber(fromPayload('qty_on_hand', existing?.qty_on_hand ?? 0)),
      toNumber(fromPayload('reorder_point', existing?.reorder_point ?? 0)),
      fromPayload('notes', existing?.notes ?? null),
      fromPayload('is_active', existing?.is_active ?? true) !== false,
      fromPayload('is_service', existing?.is_service ?? false) === true,
      fromPayload('requires_core_return', existing?.requires_core_return ?? false) === true,
      toMoney(fromPayload('core_deposit_amount', existing?.core_deposit_amount ?? 0), Number(existing?.core_deposit_amount ?? 0), 'Застава'),
      fromPayload('storage_bin', existing?.storage_bin ?? null),
      fromPayload('is_favorite', existing?.is_favorite ?? false) === true,
      photoUrl,
      fromPayload('specs', existing?.specs ?? {}),
      JSON.stringify(additionalBarcodes),
      updatedAt,
    ]
    const { insertValues, updateValues } = buildProductSyncQueryValues(
      productValues,
      payload.stock_correction === true,
    )

    if (existing) {
      await client.query(
        `UPDATE products SET
          sku = $3, name = $4, barcode = $5, brand_id = $6, category_id = $7,
          unit = $8, purchase_price = $9, retail_price = $10,
          qty_on_hand = CASE WHEN $24::boolean THEN $11::numeric ELSE products.qty_on_hand END,
          reorder_point = $12, notes = $13, is_active = $14, is_service = $15,
          requires_core_return = $16, core_deposit_amount = $17,
          storage_bin = $18, is_favorite = $19, photo_url = $20, specs = $21,
          additional_barcodes = $22::jsonb, deleted_at = NULL, updated_at = $23
        WHERE id = $1 AND tenant_id = $2`,
        updateValues,
      )
    } else {
      await client.query(
        `INSERT INTO products (
          id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
          purchase_price, retail_price, qty_on_hand, reorder_point, notes,
          is_active, is_service, requires_core_return, core_deposit_amount,
          storage_bin, is_favorite, photo_url, specs, additional_barcodes,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11::numeric, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21, $22::jsonb,
          $23, $23
        )`,
        insertValues,
      )
    }

    // Крос-номери/аналоги з картки товару (офлайн-desktop → сервер): повний список замінює наявні.
    if (owns('cross_numbers')) {
      const list = Array.isArray(payload.cross_numbers) ? payload.cross_numbers : []
      const uniqueCross = new Map<string, string>()
      for (const raw of list) {
        const num = String(raw ?? '').trim()
        const norm = normalizeOemValue(num)
        if (norm) uniqueCross.set(norm, num)
      }
      const normalizedCrossNumbers = [...uniqueCross.keys()]
      await client.query(
        `UPDATE product_cross_numbers
         SET deleted_at = $4, updated_at = $4
         WHERE product_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           AND NOT (normalized_number = ANY($3::text[]))`,
        [productId, tenantId, normalizedCrossNumbers, updatedAt],
      )
      for (const [norm, num] of uniqueCross) {
        await client.query(
          `INSERT INTO product_cross_numbers (
             tenant_id, product_id, number, normalized_number, number_type,
             source, is_verified, updated_at, deleted_at
           ) VALUES ($1, $2, $3, $4, 'cross', 'Картка товару', true, $5, NULL)
           ON CONFLICT (tenant_id, product_id, normalized_number) DO UPDATE SET
             number = EXCLUDED.number,
             number_type = EXCLUDED.number_type,
             source = EXCLUDED.source,
             is_verified = EXCLUDED.is_verified,
             updated_at = EXCLUDED.updated_at,
             deleted_at = NULL`,
          [tenantId, productId, num, norm, updatedAt],
        )
      }
    }

    if (!barcodesTouched) return

    for (const barcode of barcodes) {
      const duplicateFromIndex = await client.query(
        `SELECT p.name, p.sku
         FROM product_barcodes b
         JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
         WHERE b.tenant_id = $1
           AND b.barcode = $2
           AND b.product_id <> $3
           AND b.deleted_at IS NULL
           AND p.deleted_at IS NULL
         LIMIT 1`,
        [tenantId, barcode, productId],
      )
      const duplicateFromProduct = duplicateFromIndex.rowCount
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
      if (duplicateFromProduct.rowCount) {
        const duplicate = duplicateFromProduct.rows[0]
        throw new AppError(
          'BARCODE_TAKEN',
          `Штрихкод "${barcode}" вже у товару "${duplicate.name || duplicate.sku || 'іншого товару'}"`,
          409,
        )
      }
    }

    await client.query(
      `UPDATE product_barcodes
       SET deleted_at = $4, updated_at = $4
       WHERE product_id = $1
         AND tenant_id = $2
         AND deleted_at IS NULL
         AND NOT (barcode = ANY($3::text[]))`,
      [productId, tenantId, barcodes, updatedAt],
    )

    for (const barcode of barcodes) {
      await client.query(
        `INSERT INTO product_barcodes (
          id, tenant_id, product_id, barcode, barcode_type, is_primary,
          created_at, updated_at, deleted_at
        ) VALUES ($1, $2, $3, $4, 'ean13', $5, $6, $6, NULL)
        ON CONFLICT (tenant_id, barcode) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          barcode_type = EXCLUDED.barcode_type,
          is_primary = EXCLUDED.is_primary,
          updated_at = EXCLUDED.updated_at,
          deleted_at = NULL
        WHERE product_barcodes.product_id = EXCLUDED.product_id
           OR product_barcodes.deleted_at IS NOT NULL`,
        [randomUUID(), tenantId, productId, barcode, barcode === primaryBarcode, updatedAt],
      )
    }
  })
}

async function applyProductDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const deletedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET deleted_at = $3, is_active = false, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, deletedAt],
    )
    for (const table of ['product_barcodes', 'product_aliases', 'product_cross_numbers']) {
      await client.query(
        `UPDATE ${table}
         SET deleted_at = $3, updated_at = $3
         WHERE product_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [operation.aggregate_id, tenantId, deletedAt],
      )
    }
  })
}
async function applyInventoryCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(sessionId)) throw new AppError('SYNC_INVENTORY_INVALID', 'Некоректна ревізія', 400)
  const name = String(payload.name ?? `Локальна ревізія ${sessionId.slice(0, 8)}`).trim().slice(0, 200)
    || 'Локальна ревізія'
  const createdBy = isUuid(payload.created_by) ? payload.created_by : userId
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const tombstone = await client.query(
      `SELECT 1 FROM sync_deletions
       WHERE tenant_id = $1 AND entity_type = 'inventory_session' AND entity_id = $2
       LIMIT 1`,
      [tenantId, sessionId],
    )
    if (tombstone.rowCount) return
    await client.query(
      `INSERT INTO inventory_sessions (id, tenant_id, name, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [sessionId, tenantId, name, createdBy, createdAt, appliedAt],
    )
    const session = await client.query(
      'SELECT tenant_id FROM inventory_sessions WHERE id = $1 LIMIT 1',
      [sessionId],
    )
    if (!session.rowCount || session.rows[0].tenant_id !== tenantId) {
      throw new AppError('SYNC_INVENTORY_TENANT_CONFLICT', 'Ревізія належить іншому магазину', 409)
    }
  })
}

async function applyInventoryStarted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(sessionId)) throw new AppError('SYNC_INVENTORY_INVALID', 'Некоректна ревізія', 400)
  const startedBy = isUuid(payload.started_by) ? payload.started_by : userId
  const startedAt = payload.started_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const session = await client.query(
      'SELECT status FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [sessionId, tenantId],
    )
    if (!session.rowCount) {
      const tombstone = await client.query(
        `SELECT 1 FROM sync_deletions
         WHERE tenant_id = $1 AND entity_type = 'inventory_session' AND entity_id = $2
         LIMIT 1`,
        [tenantId, sessionId],
      )
      if (tombstone.rowCount) return
      throw new AppError('SYNC_INVENTORY_NOT_FOUND', 'Ревізію не знайдено', 404)
    }
    if (session.rows[0].status === 'completed') return
    await client.query(
      `UPDATE inventory_sessions
       SET status = 'in_progress', started_by = COALESCE(started_by, $3),
           started_at = COALESCE(started_at, $4), updated_at = $5
       WHERE id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, startedBy, startedAt, appliedAt],
    )
  })
}

async function applyInventoryDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const sessionId = String(operation.payload?.id ?? operation.aggregate_id)
  if (!isUuid(sessionId)) throw new AppError('SYNC_INVENTORY_INVALID', 'Некоректна ревізія', 400)

  await runTransaction(async (client) => {
    const session = await client.query(
      'SELECT status FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [sessionId, tenantId],
    )
    if (session.rows[0]?.status === 'completed') {
      throw new AppError('INVENTORY_COMPLETED', 'Завершену ревізію видаляти не можна', 400)
    }
    if (session.rowCount) {
      const content = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM inventory_items WHERE session_id = $1 AND was_counted = true) AS counted,
           EXISTS(SELECT 1 FROM inventory_count_entries WHERE session_id = $1) AS entries`,
        [sessionId],
      )
      if (content.rows[0]?.counted || content.rows[0]?.entries) {
        throw new AppError('INVENTORY_NOT_EMPTY', 'Видаляти можна тільки порожні незавершені ревізії', 400)
      }
      await client.query('DELETE FROM inventory_sessions WHERE id = $1 AND tenant_id = $2', [sessionId, tenantId])
    }
    await client.query(
      `INSERT INTO sync_deletions (tenant_id, entity_type, entity_id, deleted_at)
       VALUES ($1, 'inventory_session', $2, clock_timestamp())
       ON CONFLICT (tenant_id, entity_type, entity_id)
       DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
      [tenantId, sessionId],
    )
  })
}

async function applyInventoryCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .filter((item: any) => {
      const countedStock = Number(item?.counted_stock ?? 0)
      return Boolean(item?.product_id) && Number.isFinite(countedStock) && countedStock >= 0
    })
  if (items.length === 0) {
    throw new AppError('SYNC_INVENTORY_EMPTY', 'Неможливо завершити порожню ревізію', 422)
  }
  const createdBy = payload.created_by ?? userId
  const createdAt = payload.created_at ?? operation.created_at
  const completedAt = payload.completed_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  const name = String(payload.name ?? `Локальна ревізія ${sessionId.slice(0, 8)}`).trim() || 'Локальна ревізія'

  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO inventory_sessions (
        id, tenant_id, name, status, created_by, started_by, started_at, completed_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'in_progress', $4, $4, $5, NULL, $5, $6
      )
      ON CONFLICT (id) DO NOTHING`,
      [sessionId, tenantId, name, createdBy, createdAt, appliedAt],
    )
    const sessionState = await client.query(
      'SELECT status FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [sessionId, tenantId],
    )
    if (!sessionState.rowCount) {
      throw new AppError('SYNC_INVENTORY_TENANT_CONFLICT', 'Ревізія належить іншому магазину', 409)
    }
    if (sessionState.rows[0]?.status === 'completed') return
    await client.query(`SELECT set_config('app.stock_source_type', 'inventory', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [sessionId])

    const touchedProductIds: string[] = []
    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      if (!productId) continue
      const countedStock = Number(item?.counted_stock ?? 0)
      if (!Number.isFinite(countedStock) || countedStock < 0) continue

      const product = await client.query(
        'SELECT id, COALESCE(qty_on_hand, 0) AS qty_on_hand, updated_at FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
        [productId, tenantId],
      )
      if (!product.rowCount) {
        throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар ревізії не знайдено: ${productId}`, 404)
      }

      const expectedStock = Number(item?.expected_stock)
      const serverStock = Number(product.rows[0].qty_on_hand ?? 0)
      if (!Number.isFinite(expectedStock)) {
        throw new AppError('SYNC_INVENTORY_BASE_MISSING', 'Стара ревізія не містить базового залишку. Відкрийте її та перерахуйте товар.', 409)
      }
      if (serverStock !== expectedStock && serverStock !== countedStock) {
        throw new AppError('SYNC_INVENTORY_CONFLICT', 'Залишок товару змінився після початку ревізії: було ' + expectedStock + ', зараз ' + serverStock + '. Оновіть ревізію і перерахуйте позицію.', 409)
      }

      const itemResult = await client.query(
        `INSERT INTO inventory_items (
          session_id, product_id, expected_stock, counted_stock, was_counted,
          price_checked, last_counted_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, true, true, $5, $6, $7
        )
        ON CONFLICT (session_id, product_id) DO UPDATE SET
          counted_stock = EXCLUDED.counted_stock,
          was_counted = true,
          price_checked = true,
          last_counted_by = EXCLUDED.last_counted_by,
          updated_at = EXCLUDED.updated_at
        RETURNING id`,
        [sessionId, productId, expectedStock, countedStock, createdBy, completedAt, appliedAt],
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
        [countedStock, appliedAt, productId, tenantId],
      )
      touchedProductIds.push(productId)
    }
    if (touchedProductIds.length > 0) {
      await client.query(
        'UPDATE products SET updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tenantId, [...new Set(touchedProductIds)]],
      )
      await client.query(
        'UPDATE inventory_items SET updated_at = clock_timestamp() WHERE session_id = $1',
        [sessionId],
      )
    }
    await client.query(
      `UPDATE inventory_sessions
       SET status = 'completed', completed_at = $3, name = $4, updated_at = $5
       WHERE id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, completedAt, name, appliedAt],
    )
  })
}


async function applyCustomerDebtPaid(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' ? payload.method : 'cash'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  if (!customerId || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('SYNC_CUSTOMER_DEBT_INVALID', 'Некоректна оплата боргу', 400)
  }

  await runTransaction(async (client) => {
    const idempotencyKey = `desktop:customer.debt_paid:${operation.operation_id}`
    const claim = await client.query(
      `INSERT INTO idempotency_keys (key, tenant_id, response, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key, tenant_id) DO NOTHING
       RETURNING key`,
      [idempotencyKey, tenantId, JSON.stringify({ operation_id: operation.operation_id }), appliedAt],
    )
    if (!claim.rowCount) return

    const customerResult = await client.query(
      'SELECT id, full_name, phone, COALESCE(debt_balance, 0) AS debt_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    if (Number(customer.debt_balance ?? 0) <= 0) return
    const paid = Math.min(amount, Number(customer.debt_balance ?? 0))
    const balanceAfter = Number(customer.debt_balance ?? 0) - paid
    await client.query(
      'UPDATE customers SET debt_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId, balanceAfter, appliedAt],
    )
    if (method === 'cash' && payload.shift_id) {
      const cashOperationId = isUuid(payload.cash_operation_id) ? payload.cash_operation_id : operation.operation_id
      await client.query(
        `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [cashOperationId, tenantId, payload.shift_id, paid, payload.notes ?? (`Оплата боргу: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`), payload.created_by ?? userId, createdAt, appliedAt],
      )
    }
  })
}

async function applyCustomerDepositChanged(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const transactionId = String(payload.transaction_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' || payload.method === 'account' || payload.method === 'correction' || payload.method === 'cashback'
    ? payload.method
    : 'cash'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  if (!customerId || !transactionId || !Number.isFinite(amount) || amount === 0) {
    throw new AppError('SYNC_CUSTOMER_DEPOSIT_INVALID', 'Некоректний рух рахунку клієнта', 400)
  }

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id, tenant_id FROM customer_deposit_transactions WHERE id = $1 LIMIT 1', [transactionId])
    if (existing.rowCount && existing.rowCount > 0) {
      if (existing.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_DEPOSIT_TENANT_CONFLICT', 'Операція рахунку належить іншому магазину', 409)
      }
      return
    }

    const customerResult = await client.query(
      'SELECT id, full_name, phone, COALESCE(deposit_balance, 0) AS deposit_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    const balanceAfter = Number(customer.deposit_balance ?? 0) + amount
    if (balanceAfter < 0) throw new AppError('INSUFFICIENT_DEPOSIT', 'Недостатньо коштів на рахунку клієнта', 400)

    await client.query(
      'UPDATE customers SET deposit_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId, balanceAfter, appliedAt],
    )
    await client.query(
      `INSERT INTO customer_deposit_transactions (
        id, tenant_id, customer_id, amount, balance_after, method, order_id, sale_id,
        shift_id, notes, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [transactionId, tenantId, customerId, amount, balanceAfter, method, payload.order_id ?? null, payload.sale_id ?? null, payload.shift_id ?? null, payload.notes ?? null, payload.created_by ?? userId, createdAt, appliedAt],
    )

    if (method === 'cash' && payload.shift_id) {
      const cashOperationId = isUuid(payload.cash_operation_id) ? payload.cash_operation_id : operation.operation_id
      const cashType = amount < 0 ? 'out' : 'in'
      const cashNote = payload.notes ?? (amount < 0
        ? `Видача з рахунку клієнта: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`
        : `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`)
      await client.query(
        `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [cashOperationId, tenantId, payload.shift_id, cashType, Math.abs(amount), cashNote, payload.created_by ?? userId, createdAt, appliedAt],
      )
    }
  })
}

async function applyCustomerBonusAdjusted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const transactionId = String(payload.transaction_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  if (!isUuid(customerId) || !isUuid(transactionId) || !Number.isFinite(amount) || amount === 0) {
    throw new AppError('SYNC_CUSTOMER_BONUS_INVALID', 'Некоректна зміна бонусів клієнта', 400)
  }

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id, tenant_id FROM bonus_transactions WHERE id = $1 LIMIT 1', [transactionId])
    if (existing.rowCount && existing.rowCount > 0) {
      if (existing.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_BONUS_TENANT_CONFLICT', 'Бонусна операція належить іншому магазину', 409)
      }
      return
    }

    const updated = await client.query(
      `UPDATE customers
       SET bonus_balance = COALESCE(bonus_balance, 0) + $1, updated_at = $2
       WHERE id = $3 AND tenant_id = $4 AND deleted_at IS NULL
         AND COALESCE(bonus_balance, 0) + $1 >= 0
       RETURNING bonus_balance`,
      [amount, appliedAt, customerId, tenantId],
    )
    if (!updated.rowCount) {
      throw new AppError('SYNC_CUSTOMER_BONUS_REJECTED', 'Клієнта не знайдено або недостатньо бонусів', 409)
    }
    await client.query(
      `INSERT INTO bonus_transactions (
        id, tenant_id, customer_id, amount, transaction_type, description, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8)`,
      [transactionId, tenantId, customerId, amount, payload.description ?? (amount > 0 ? 'Ручне нарахування' : 'Ручне списання'), payload.created_by ?? userId, createdAt, appliedAt],
    )
  })
}
async function applyOrderPaymentAdded(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.order_id ?? operation.aggregate_id)
  const paymentId = String(payload.payment_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' || payload.method === 'account'
    ? payload.method
    : 'cash'
  const shiftId = isUuid(payload.shift_id) ? payload.shift_id : null
  const createdBy = isUuid(payload.created_by) ? payload.created_by : userId
  if (!isUuid(orderId) || !isUuid(paymentId) || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('SYNC_ORDER_PAYMENT_INVALID', 'Некоректний платіж замовлення', 400)
  }
  if (!shiftId) {
    throw new AppError('SYNC_ORDER_PAYMENT_SHIFT_REQUIRED', 'Для платежу не вказано касову зміну', 400)
  }

  await addOrderPayment({
    payment_id: paymentId,
    order_id: orderId,
    tenant_id: tenantId,
    user_id: createdBy,
    amount,
    method,
    is_fiscal: payload.is_fiscal === true,
    shift_id: shiftId,
    notes: typeof payload.notes === 'string' ? payload.notes : null,
    created_at: String(payload.created_at ?? operation.created_at),
    applied_at: operation.applied_at ?? operation.created_at,
    // Offline payment was validated while the local shift was open. It can reach
    // the server after that shift closed, so validate its timestamp interval.
    accept_closed_shift: true,
  })
}

export async function applyOrderCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.order_id ?? operation.aggregate_id)
  if (!isUuid(orderId)) {
    throw new AppError('SYNC_ORDER_COMPLETE_INVALID', 'Некоректна видача замовлення', 400)
  }

  await runTransaction(async (client) => {
    const orderResult = await client.query(
      `SELECT *
       FROM customer_orders
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [orderId, tenantId],
    )
    if (!orderResult.rowCount) {
      throw new AppError('SYNC_ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    }
    const order = orderResult.rows[0]
    const linkedSaleId = isUuid(order.sale_id) ? String(order.sale_id) : null

    if (linkedSaleId) {
      const existingLinkedSale = await client.query(
        'SELECT id, tenant_id FROM sales WHERE id = $1 LIMIT 1',
        [linkedSaleId],
      )
      if (existingLinkedSale.rowCount && existingLinkedSale.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_SALE_TENANT_CONFLICT', 'Чек належить іншому магазину', 409)
      }
      if (existingLinkedSale.rowCount) {
        const appliedAt = operation.applied_at ?? operation.created_at
        await client.query(
          `UPDATE customer_order_items AS item
           SET item_status = 'handed'
           FROM customer_orders AS parent
           WHERE item.order_id = $1
             AND parent.id = item.order_id
             AND parent.tenant_id = $2
             AND item.item_status NOT IN ('canceled', 'handed')`,
          [orderId, tenantId],
        )
        await client.query(
          'UPDATE inventory_reserves SET released_at = COALESCE(released_at, $2) WHERE order_id = $1 AND tenant_id = $3 AND released_at IS NULL',
          [orderId, appliedAt, tenantId],
        )
        await client.query(
          `UPDATE customer_orders
           SET status = 'completed', updated_at = $3
           WHERE id = $1 AND tenant_id = $2`,
          [orderId, tenantId, appliedAt],
        )
        return
      }
    }

    if (order.status === 'canceled' || order.status === 'archived') {
      throw new AppError('SYNC_ORDER_INVALID_STATUS', 'Скасоване або архівне замовлення не можна видати', 409)
    }

    const paymentResult = await client.query(
      `SELECT method, COALESCE(SUM(amount), 0)::bigint AS amount
       FROM order_payments
       WHERE order_id = $1 AND tenant_id = $2
       GROUP BY method`,
      [orderId, tenantId],
    )
    const paymentTotals = { cash: 0, card: 0, transfer: 0 }
    for (const payment of paymentResult.rows) {
      const amount = Math.max(0, Math.round(Number(payment.amount ?? 0)))
      if (payment.method === 'card') paymentTotals.card += amount
      else if (payment.method === 'transfer' || payment.method === 'account') paymentTotals.transfer += amount
      else paymentTotals.cash += amount
    }
    const authoritativePaid = paymentTotals.cash + paymentTotals.card + paymentTotals.transfer
    const amountDue = Math.max(0, Number(order.total_amount ?? 0) - Number(order.discount_amount ?? 0))
    if (authoritativePaid !== amountDue) {
      const code = authoritativePaid > amountDue ? 'SYNC_ORDER_OVERPAID' : 'SYNC_ORDER_INCOMPLETE_PAYMENT'
      const message = authoritativePaid > amountDue
        ? 'Оплата перевищує суму замовлення. Спочатку поверніть або зарахуйте надлишок.'
        : 'Не всі оплати проведено через касу'
      throw new AppError(code, message, 409)
    }

    const itemResult = await client.query(
      `SELECT item.id, item.product_id, item.name, item.sku, item.qty,
              item.sell_price, item.buy_price, item.core_deposit_amount,
              item.core_return_status, item.item_status
       FROM customer_order_items AS item
       JOIN customer_orders AS parent ON parent.id = item.order_id
       WHERE item.order_id = $1
         AND parent.tenant_id = $2
         AND item.item_status <> 'canceled'
       ORDER BY item.created_at ASC
       FOR UPDATE OF item`,
      [orderId, tenantId],
    )
    if (!itemResult.rowCount) {
      throw new AppError('SYNC_ORDER_EMPTY', 'У замовленні немає активних позицій для видачі', 422)
    }

    const unlinked = itemResult.rows.filter((item) => !isUuid(item.product_id))
    if (unlinked.length > 0) {
      const names = unlinked.slice(0, 3).map((item) => `«${item.name || 'Без назви'}»`).join(', ')
      const suffix = unlinked.length > 3 ? ` та ще ${unlinked.length - 3}` : ''
      throw new AppError(
        'SYNC_ORDER_ITEM_NOT_LINKED',
        `Не можна видати замовлення. Не прив'язано до картки товару: ${names}${suffix}. Виберіть товар у кожній позиції.`,
        422,
      )
    }

    const allowNegativeResult = await client.query(
      'SELECT COALESCE((SELECT allow_negative_qty FROM shop_settings WHERE tenant_id = $1 LIMIT 1), false) AS allow_negative',
      [tenantId],
    )
    const allowNegative = allowNegativeResult.rows[0]?.allow_negative !== false
    const payloadItems = Array.isArray(payload.items) ? payload.items : []
    const payloadByOrderItem = new Map<string, any>(
      payloadItems
        .filter((item: any) => item?.order_item_id)
        .map((item: any) => [String(item.order_item_id), item]),
    )

    let subtotal = 0
    const items: Array<{
      id: string
      order_item_id: string
      product_id: string
      qty: number
      unit_price: number
      purchase_price: number
      discount: number
      total: number
      core_deposit_amount: number
      core_return_status: string
      is_service: boolean
    }> = []

    for (const orderItem of itemResult.rows) {
      const productResult = await client.query(
        `SELECT id, name, sku, qty_on_hand, is_service, purchase_price,
                requires_core_return, core_deposit_amount
         FROM products
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [orderItem.product_id, tenantId],
      )
      if (!productResult.rowCount) {
        throw new AppError(
          'SYNC_PRODUCT_NOT_FOUND',
          `Товар «${orderItem.name || orderItem.product_id}» не знайдено`,
          404,
        )
      }

      const product = productResult.rows[0]
      const qty = Number(orderItem.qty ?? 0)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError('SYNC_ORDER_QTY_INVALID', `Некоректна кількість у позиції «${orderItem.name || product.name}»`, 422)
      }
      const unitPrice = Math.round(Number(orderItem.sell_price ?? 0))
      const merchandiseTotal = Math.round(unitPrice * qty)
      const isService = product.is_service === true
      if (!isService && !allowNegative && Number(product.qty_on_hand ?? 0) < qty) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `Недостатньо залишку для «${product.name}»: є ${Number(product.qty_on_hand ?? 0)}, потрібно ${qty}`,
          422,
        )
      }

      const payloadItem = payloadByOrderItem.get(String(orderItem.id))
      const rawCoreDepositAmount = Number(
        orderItem.core_deposit_amount
          ?? (product.requires_core_return === true ? product.core_deposit_amount : 0)
          ?? 0,
      )
      const coreDepositAmount = Number.isFinite(rawCoreDepositAmount)
        ? Math.max(0, Math.round(rawCoreDepositAmount))
        : 0
      const lineTotal = merchandiseTotal + Math.round(coreDepositAmount * qty)
      subtotal += lineTotal
      items.push({
        id: isUuid(payloadItem?.id) ? payloadItem.id : randomUUID(),
        order_item_id: String(orderItem.id),
        product_id: String(product.id),
        qty,
        unit_price: unitPrice,
        purchase_price: Math.round(Number(orderItem.buy_price ?? product.purchase_price ?? 0)),
        discount: 0,
        total: lineTotal,
        core_deposit_amount: coreDepositAmount,
        core_return_status: String(
          orderItem.core_return_status && orderItem.core_return_status !== 'none'
            ? orderItem.core_return_status
            : coreDepositAmount > 0 ? 'pending' : 'none',
        ),
        is_service: isService,
      })
    }

    const cashierId = uuidOr(payload.cashier_id, userId)
    let shiftId = isUuid(payload.shift_id) ? String(payload.shift_id) : null
    if (shiftId) {
      const shift = await client.query(
        'SELECT id, tenant_id FROM shifts WHERE id = $1 LIMIT 1',
        [shiftId],
      )
      if (shift.rowCount && shift.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_SHIFT_TENANT_CONFLICT', 'Касова зміна належить іншому магазину', 409)
      }
      if (!shift.rowCount) {
        const appliedAt = operation.applied_at ?? operation.created_at
        await client.query(
          `INSERT INTO shifts (
            id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at
          ) VALUES ($1, $2, $3, 'open', 0, $4, $5, $4)`,
          [shiftId, tenantId, cashierId, appliedAt, 'Створено під час офлайн-видачі замовлення'],
        )
      }
    } else {
      const shift = await client.query(
        `SELECT id FROM shifts
         WHERE tenant_id = $1 AND status = 'open'
         ORDER BY opened_at DESC
         LIMIT 1`,
        [tenantId],
      )
      shiftId = shift.rowCount ? String(shift.rows[0].id) : null
    }
    if (!shiftId) throw new AppError('SYNC_OPEN_SHIFT_REQUIRED', 'Спочатку відкрийте касову зміну', 422)

    const saleId = isUuid(payload.sale_id)
      ? String(payload.sale_id)
      : linkedSaleId ?? randomUUID()
    const existingSale = await client.query(
      'SELECT id, tenant_id FROM sales WHERE id = $1 LIMIT 1',
      [saleId],
    )
    if (existingSale.rowCount && existingSale.rows[0].tenant_id !== tenantId) {
      throw new AppError('SYNC_SALE_TENANT_CONFLICT', 'Чек належить іншому магазину', 409)
    }
    if (existingSale.rowCount) {
      const otherOrder = await client.query(
        `SELECT id FROM customer_orders
         WHERE tenant_id = $1 AND sale_id = $2 AND id <> $3
         LIMIT 1`,
        [tenantId, saleId, orderId],
      )
      if (otherOrder.rowCount) {
        throw new AppError('SYNC_SALE_ALREADY_LINKED', 'Цей чек уже прив’язано до іншого замовлення', 409)
      }
      const appliedAt = operation.applied_at ?? operation.created_at
      await client.query(
        `UPDATE customer_order_items AS item
         SET item_status = 'handed'
         FROM customer_orders AS parent
         WHERE item.order_id = $1
           AND parent.id = item.order_id
           AND parent.tenant_id = $2
           AND item.item_status NOT IN ('canceled', 'handed')`,
        [orderId, tenantId],
      )
      await client.query(
        `UPDATE customer_orders
         SET status = 'completed', sale_id = $3, updated_at = $4
         WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId, saleId, appliedAt],
      )
      await client.query(
        'UPDATE inventory_reserves SET released_at = COALESCE(released_at, $2) WHERE order_id = $1 AND tenant_id = $3 AND released_at IS NULL',
        [orderId, appliedAt, tenantId],
      )
      return
    }

    let saleNumber = String(payload.sale_number ?? '').trim()
    if (!saleNumber) {
      const sequence = await client.query("SELECT LPAD(nextval('sale_number_seq')::TEXT, 6, '0') AS sale_number")
      saleNumber = String(sequence.rows[0].sale_number)
    }

    const usedPaymentMethods = [
      paymentTotals.cash > 0 ? 'cash' : null,
      paymentTotals.card > 0 ? 'card' : null,
      paymentTotals.transfer > 0 ? 'transfer' : null,
    ].filter(Boolean)
    const paymentMethod = usedPaymentMethods.length > 1 ? 'mixed' : String(usedPaymentMethods[0] ?? 'cash')
    const cashAmount = paymentTotals.cash
    const cardAmount = paymentTotals.card
    const transferAmount = paymentTotals.transfer
    const discount = Math.max(0, Math.round(Number(order.discount_amount ?? payload.discount ?? 0)))
    const total = Math.max(0, subtotal - discount)
    if (total !== amountDue) {
      throw new AppError('SYNC_ORDER_TOTAL_CONFLICT', 'Сума позицій замовлення змінилася. Оновіть заказ і повторіть оплату.', 409)
    }
    const completedAt = payload.completed_at ?? operation.created_at
    const appliedAt = operation.applied_at ?? operation.created_at
    const managerId = uuidOr(payload.manager_id ?? order.manager_id ?? payload.cashier_id, userId)
    const customerId = isUuid(order.customer_id) ? order.customer_id : null

    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, transfer_amount, is_fiscal, completed_at, created_at, updated_at, pickup_cell
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'completed',
        $7, $8, $9, $10, false, $11, $12,
        $13, $14, $15, $16, $17, $17, $18, $19
      )`,
      [
        saleId,
        tenantId,
        saleNumber,
        customerId,
        cashierId,
        shiftId,
        subtotal,
        discount,
        total,
        paymentMethod,
        payload.notes ?? `Видача замовлення #${order.order_number ?? String(orderId).slice(0, 8)}`,
        managerId,
        cashAmount,
        cardAmount,
        transferAmount,
        payload.is_fiscal === true,
        completedAt,
        appliedAt,
        payload.pickup_cell ?? order.pickup_cell ?? null,
      ],
    )

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total,
          cost_price, core_deposit_amount, core_return_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          item.id,
          tenantId,
          saleId,
          item.product_id,
          item.qty,
          item.unit_price,
          item.discount,
          item.total,
          item.purchase_price,
          item.core_deposit_amount,
          item.core_return_status,
        ],
      )
      if (!item.is_service) {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [item.qty, appliedAt, item.product_id, tenantId],
        )
      }
    }

    await client.query(
      'UPDATE inventory_reserves SET released_at = COALESCE(released_at, $2) WHERE order_id = $1 AND tenant_id = $3 AND released_at IS NULL',
      [orderId, appliedAt, tenantId],
    )
    await client.query(
      `UPDATE customer_order_items AS item
       SET item_status = 'handed'
       FROM customer_orders AS parent
       WHERE item.order_id = $1
         AND parent.id = item.order_id
         AND parent.tenant_id = $2
         AND item.item_status NOT IN ('canceled', 'handed')`,
      [orderId, tenantId],
    )
    await client.query(
      `UPDATE customer_orders
       SET status = 'completed', sale_id = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId, saleId, appliedAt],
    )
    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'completed', $3, $4)`,
      [
        orderId,
        cashierId,
        { method: paymentMethod, offline: true, shift_id: shiftId, sale_id: saleId },
        appliedAt,
      ],
    )
  })
}



