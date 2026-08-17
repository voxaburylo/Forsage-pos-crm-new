import type { Product } from '@/types/product'
import type { Shift } from '@/types/shift'
import type { Sale } from '@/types/sale'

export type DesktopLanMode = 'standalone' | 'hub' | 'client'

export interface DesktopLanStatus {
  mode: DesktopLanMode
  port: number
  hubAddress: string
  accessKey: string
  allowedUserId: string
  addresses: string[]
  running: boolean
  connected: boolean
  lastError: string | null
}

export interface DesktopRuntimeInfo {
  databasePath: string
  deviceId: string
  schemaVersion: number
  pendingOperations: number
  lan?: DesktopLanStatus | null
}

export interface DesktopProduct {
  id: string
  tenant_id: string
  sku: string
  name: string
  barcode: string | null
  brand_id?: string | null
  brand_name?: string | null
  category_id?: string | null
  category_name?: string | null
  unit: string
  purchase_price: number
  retail_price: number
  qty_on_hand: number
  qty_reserved?: number
  qty_available?: number
  reorder_point?: number
  notes?: string | null
  is_active: number
  is_service: number
  requires_core_return?: number
  core_deposit_amount?: number
  storage_bin: string | null
  is_favorite?: number
  photo_url?: string | null
  specs_json?: string | null
  created_at?: string
  updated_at?: string
}

export interface DesktopCatalogListOptions {
  query?: string
  limit?: number
  offset?: number
  categoryId?: string
  brandId?: string
  lowStock?: boolean
  stockFilter?: 'negative' | 'no_price' | ''
  sortField?: 'sku' | 'name' | 'retail_price' | 'qty_on_hand' | 'brand'
  sortDir?: 'asc' | 'desc'
}

export interface DesktopCatalogListResult {
  data: DesktopProduct[]
  total: number
}
export interface DesktopCheckoutInput {
  client_operation_id?: string
  cashier_id: string
  shift_id?: string | null
  customer_id?: string | null
  manager_id?: string | null
  notes?: string | null
  discount?: number
  bonuses_spent?: number
  is_fiscal?: boolean
  fiscal_number?: string | null
  fiscal_qr_url?: string | null
  items: Array<{
    product_id?: string | null
    description?: string | null
    qty: number
    unit_price?: number
    discount?: number
  }>
  payments: Array<{
    method: 'cash' | 'card' | 'debt' | 'transfer'
    amount: number
    is_fiscal?: boolean
    fiscal_number?: string | null
    bank_auth_code?: string | null
    terminal_rrn?: string | null
  }>
}

export interface DesktopCheckoutResult {
  sale_id: string
  sale_number: string
  total: number
  subtotal: number
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  outbox_sequence: number
}

export interface DesktopBootstrapSnapshot {
  exported_at: string
  tenant_id: string
  reset_required?: boolean
  reset_generation?: number
  reset_at?: string | null
  staff?: unknown[]
  staff_pins?: unknown[]
  categories?: unknown[]
  brands?: unknown[]
  suppliers?: unknown[]
  products?: unknown[]
  product_barcodes?: unknown[]
  product_aliases?: unknown[]
  product_cross_numbers?: unknown[]
  customers?: unknown[]
  customer_vehicles?: unknown[]
  customer_orders?: unknown[]
  deleted_customer_order_ids?: string[]
  customer_order_items?: unknown[]
  order_payments?: unknown[]
  shifts?: unknown[]
  sales?: unknown[]
  sale_items?: unknown[]
  commission_rules?: unknown[]
  salary_payments?: unknown[]
  deleted_salary_payment_ids?: string[]
  cash_operations?: unknown[]
  deleted_cash_operation_ids?: string[]
  customer_returns?: unknown[]
  customer_return_items?: unknown[]
  stock_reserves?: unknown[]
  warehouse_movements?: unknown[]
  writeoffs?: unknown[]
  writeoff_items?: unknown[]
  bonus_transactions?: unknown[]
  customer_deposit_transactions?: unknown[]
  supply_invoices?: unknown[]
  deleted_supply_invoice_ids?: string[]
  supply_invoice_items?: unknown[]
  supplier_payments?: unknown[]
  supplier_price_items?: unknown[]
  supplier_price_imports?: unknown[]
  inventory_sessions?: unknown[]
  deleted_inventory_session_ids?: string[]
  inventory_items?: unknown[]
  shop_settings?: Record<string, unknown> | null
  counts?: Record<string, number>
}

export interface DesktopBootstrapImportResult {
  imported_at: string
  tenant_id: string
  counts: Record<string, number>
}

export interface DesktopSyncOutboxOperation {
  sequence: number
  operation_id: string
  tenant_id: string
  device_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload: unknown
  created_at: string
  attempts: number
  last_error: string | null
}

export interface DesktopSyncPushResult {
  sequence: number
  operation_id: string
  status: 'synced' | 'failed' | 'discarded'
  aggregate_id?: string
  error?: string
  error_code?: 'SYNC_RESET_REQUIRED'
  reset_generation?: number
  reset_at?: string
}

export interface DesktopSyncPullState {
  cursor: string | null
  last_success_at: string | null
  last_reference_sync_at: string | null
  reset_generation: number
  last_error: string | null
}

export interface DesktopSyncPullChanges {
  tenant_id?: string
  cursor: string
  staff?: unknown[]
  staff_directory?: unknown[]
  staff_pins?: unknown[]
  reset_required?: boolean
  reset_generation?: number
  reset_at?: string | null
  products?: unknown[]
  deleted_product_ids?: string[]
  customers?: unknown[]
  deleted_customer_ids?: string[]
  suppliers?: unknown[]
  deleted_supplier_ids?: string[]
  categories?: unknown[]
  brands?: unknown[]
  product_barcodes?: unknown[]
  deleted_product_barcode_ids?: string[]
  product_aliases?: unknown[]
  deleted_product_alias_ids?: string[]
  product_cross_numbers?: unknown[]
  deleted_product_cross_number_ids?: string[]
  customer_vehicles?: unknown[]
  deleted_customer_vehicle_ids?: string[]
  deleted_category_ids?: string[]
  deleted_brand_ids?: string[]
  customer_orders?: unknown[]
  deleted_customer_order_ids?: string[]
  customer_order_items?: unknown[]
  order_payments?: unknown[]
  shifts?: unknown[]
  sales?: unknown[]
  sale_items?: unknown[]
  commission_rules?: unknown[]
  salary_payments?: unknown[]
  deleted_salary_payment_ids?: string[]
  cash_operations?: unknown[]
  deleted_cash_operation_ids?: string[]
  customer_returns?: unknown[]
  customer_return_items?: unknown[]
  stock_reserves?: unknown[]
  warehouse_movements?: unknown[]
  writeoffs?: unknown[]
  writeoff_items?: unknown[]
  bonus_transactions?: unknown[]
  customer_deposit_transactions?: unknown[]
  supply_invoices?: unknown[]
  deleted_supply_invoice_ids?: string[]
  supply_invoice_items?: unknown[]
  supplier_payments?: unknown[]
  supplier_price_items?: unknown[]
  supplier_price_imports?: unknown[]
  inventory_sessions?: unknown[]
  deleted_inventory_session_ids?: string[]
  inventory_items?: unknown[]
  shop_settings?: Record<string, unknown> | null
  references_included?: boolean
  catalog_structure_snapshot_included?: boolean
  staff_snapshot_included?: boolean
  staff_directory_snapshot_included?: boolean
  commission_rules_snapshot_included?: boolean
  salary_payments_snapshot_included?: boolean
  stock_reserves_snapshot_included?: boolean
}

export interface DesktopSyncPullResult {
  applied_at: string
  cursor: string
  counts: Record<string, number>
}

export interface DesktopSyncStatus {
  /** Щойно створені, ще не відправлені. */
  pending: number
  /** Впали, але ще будуть повторені автоматично. */
  retrying: number
  /** Вичерпали спроби — самі вже не поїдуть, потрібна увага. */
  stuck: number
  total: number
  oldest_created_at: string | null
  last_error: string | null
  pull_last_success_at: string | null
  pull_last_error: string | null
}

export interface DesktopFiscalConfig {
  enabled: boolean
  cashalotDir: string
  fiscalNumberRRO: string
  certificateDir: string | null
  hasPassword: boolean
  comRegistered: boolean
}

export interface DesktopFiscalConfigUpdate {
  enabled?: boolean
  cashalotDir?: string
  fiscalNumberRRO?: string
  certificateDir?: string | null
  keyPassword?: string | null
}

export interface DesktopFiscalResult {
  Return?: boolean
  Description?: string
  JsonVal?: string
  ReceiptFiscalNum?: string
  ReceiptLocalNum?: string
  ShiftID?: string
  OfflineMode?: boolean
  FSKOReceiptLink?: string
  CashalotReceiptLink?: string
  Type?: number
  Value?: unknown
}

export interface DesktopFiscalCheckItem {
  name: string
  vendor_code: string
  barcode?: string | null
  unit?: string | null
  qty: number
  unit_price: number
  amount: number
  discount?: number
  is_service?: boolean
}

export interface DesktopFiscalCheckPay {
  cash: number
  card: number
  bank?: number
  check_total: number
  auth_code?: string | null
  rrn?: string | null
  customer_email?: string | null
}

export type DesktopFiscalSaleIntentState =
  | 'prepared'
  | 'fiscalizing'
  | 'fiscalized'
  | 'unknown'
  | 'completed'

export interface DesktopFiscalSaleRequest {
  operation_id: string
  checkout: DesktopCheckoutInput
  items: DesktopFiscalCheckItem[]
  pay: DesktopFiscalCheckPay
  comment?: string | null
}

export interface DesktopFiscalSaleIntentResult {
  operation_id: string
  state: DesktopFiscalSaleIntentState
  payload_hash: string
  fiscal_result: DesktopFiscalResult | null
  checkout_result: DesktopCheckoutResult | null
  last_error: string | null
}

export interface DesktopFiscalIntentResolution {
  cashalot_checked: boolean
  confirmed_by: string
  reason: string
}

export interface DesktopFiscalReturnIntentScope {
  tenant_id?: string
  cashier_id: string
}

export interface DesktopFiscalReturnIntentResolution extends DesktopFiscalIntentResolution, DesktopFiscalReturnIntentScope {}

export interface DesktopFiscalReturnIntentCancelInput extends DesktopFiscalReturnIntentScope {
  confirmed_by: string
  reason: string
}

export interface DesktopUnresolvedFiscalReturnIntent {
  operation_id: string
  tenant_id: string
  cashier_id: string
  state: Exclude<DesktopFiscalSaleIntentState, 'completed'>
  sale_id: string | null
  sale_number: string | null
  refund_kopecks: number
  refund_method: string
  item_count: number
  fiscal_number: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  can_cancel: boolean
}

export interface DesktopFiscalReturnRequest {
  operation_id: string
  return_input: Record<string, unknown>
  items: DesktopFiscalCheckItem[]
  pay: DesktopFiscalCheckPay
  original_fiscal_number: string
}

export interface DesktopFiscalReturnProcessResult {
  intent: DesktopFiscalSaleIntentResult
  data: any
}

interface ForsageDesktopBridge {
  auth?: {
    login: (phone: string, password: string) => Promise<{ id: string; tenant_id: string; full_name: string; role: string; phone: string; email: string; is_active: boolean; created_at?: string }>
    loginOnline: (phone: string, password: string) => Promise<{ user: { id: string; tenant_id: string; full_name: string; role: string; phone: string; email: string; is_active: boolean; created_at?: string }; access_token: string; refresh_token: string; expires_in: number }>
    logout: () => Promise<{ success: true }>
  }
  getRuntimeInfo: () => Promise<DesktopRuntimeInfo>
  lan?: {
    getStatus: () => Promise<DesktopLanStatus>
    update: (input: Partial<Pick<DesktopLanStatus, 'mode' | 'port' | 'hubAddress' | 'accessKey' | 'allowedUserId'>>) => Promise<DesktopLanStatus>
    test: () => Promise<DesktopLanStatus>
  }
  backupNow: () => Promise<string>
  bootstrap: {
    importSnapshot: (snapshot: DesktopBootstrapSnapshot) => Promise<DesktopBootstrapImportResult>
  }
  catalog: {
    findByBarcode: (barcode: string) => Promise<DesktopProduct | null>
    findById?: (id: string) => Promise<DesktopProduct | null>
    findBySku?: (sku: string) => Promise<DesktopProduct | null>
    listProducts?: (options?: DesktopCatalogListOptions) => Promise<DesktopCatalogListResult>
    listProductBarcodes?: () => Promise<Array<{ product_id: string; barcode: string; is_primary?: number }>>
    listCategories?: () => Promise<Array<{ id: string; name: string; sort_order: number }>>
    listBrands?: () => Promise<Array<{ id: string; name: string; country: string | null }>>
    createCategory?: (name: string, sortOrder?: number) => Promise<{ id: string; name: string; sort_order: number }>
    updateCategory?: (id: string, name: string) => Promise<{ id: string; name: string; sort_order: number }>
    deleteCategory?: (id: string) => Promise<{ ok: true }>
    createBrand?: (name: string, country?: string | null) => Promise<{ id: string; name: string; country: string | null }>
    updateBrand?: (id: string, input: { name?: string; country?: string | null }) => Promise<{ id: string; name: string; country: string | null }>
    deleteBrand?: (id: string) => Promise<{ ok: true }>
    generateBarcode?: () => Promise<string>
    listStaff?: () => Promise<any[]>
    getSettings?: () => Promise<any>
    updateSettings?: (input: any) => Promise<any>
    searchProducts: (query: string, limit?: number) => Promise<DesktopProduct[]>
    upsertProduct: (product: {
      id: string
      sku: string
      name: string
      unit?: string
      retail_price?: number
      purchase_price?: number
      qty_on_hand?: number
      reorder_point?: number
      notes?: string | null
      brand_id?: string | null
      category_id?: string | null
      is_service?: boolean
      is_active?: boolean
      requires_core_return?: boolean
      core_deposit_amount?: number
      is_favorite?: boolean
      barcode?: string | null
      additional_barcodes?: string[]
      stock_correction?: boolean
      cross_numbers?: string[]
      storage_bin?: string | null
      photo_url?: string | null
      specs?: Record<string, string>
    }) => Promise<DesktopProduct>
    saveProduct?: (product: {
      id: string
      sku: string
      name: string
      unit?: string
      retail_price?: number
      purchase_price?: number
      qty_on_hand?: number
      reorder_point?: number
      notes?: string | null
      brand_id?: string | null
      category_id?: string | null
      is_service?: boolean
      is_active?: boolean
      requires_core_return?: boolean
      core_deposit_amount?: number
      is_favorite?: boolean
      barcode?: string | null
      additional_barcodes?: string[]
      stock_correction?: boolean
      cross_numbers?: string[]
      storage_bin?: string | null
      photo_url?: string | null
      specs?: Record<string, string>
    }, options?: { reuseExistingSku?: boolean }) => Promise<DesktopProduct>
    savePhoto?: (folder: string, bytes: ArrayBuffer) => Promise<string>
    deletePhoto?: (photoUrl: string) => Promise<{ ok: true }>
    deleteProduct?: (id: string) => Promise<{ ok: true }>
    listCrossNumbers?: (productId: string) => Promise<Array<{ id: string; number: string; source: string }>>
    listPopular: (limit?: number) => Promise<DesktopProduct[]>
  }
  supplierCatalog?: {
    list: (options?: {
      tenant_id?: string
      query?: string
      supplier_id?: string | null
      page?: number
      limit?: number
    }) => Promise<{ data: any[]; pagination: { page: number; limit: number; total: number } }>
    listImports: (tenantId?: string, limit?: number) => Promise<any[]>
    getImport: (id: string, tenantId?: string) => Promise<any | null>
    create: (input: any) => Promise<any>
    update: (id: string, input: any, tenantId?: string) => Promise<any>
    delete: (id: string, tenantId?: string) => Promise<{ ok: true }>
    importRows: (filename: string, rows: any[], options: any) => Promise<{ success: true; importId: string }>
  }
  staff?: {
    listUsers: () => Promise<any[]>
    saveServerUser: (input: any, password?: string) => Promise<any>
    updateUser: (id: string, input: any) => Promise<any>
    deleteUser: (id: string) => Promise<{ ok: true }>
    saveServerPassword: (id: string, password: string) => Promise<{ success: true }>
    setPin: (userId: string, pin: string) => Promise<{ success: true }>
    verifyPin: (userId: string, pin: string) => Promise<{ valid: boolean; error?: string }>
    listCommissionRules: () => Promise<any[]>
    createCommissionRule: (input: any) => Promise<any>
    deleteCommissionRule: (id: string) => Promise<{ ok: true }>
    listSalary: (input?: any) => Promise<any[]>
    salarySummary: (period?: string) => Promise<any[]>
    dailySummary: (workDate?: string) => Promise<any[]>
    tireServiceReport: (workDate?: string) => Promise<any>
    tireCashHandover: (input: any) => Promise<any>
    createSalary: (input: any) => Promise<any>
    dailyPayout: (input: any) => Promise<any>
    deleteSalary: (id: string) => Promise<{ success: true }>
  }
  warehouse?: {
    listMovements: (input?: any) => Promise<any>
    createMovement: (input: any) => Promise<any>
    listReserves: (tenantId?: string) => Promise<any[]>
    createReserve: (input: any) => Promise<any>
    releaseReserve: (id: string, tenantId?: string) => Promise<{ ok: true }>
    listWriteoffs: (input?: any) => Promise<any>
    getWriteoff: (id: string, tenantId?: string) => Promise<any>
    createWriteoff: (input: any) => Promise<any>
  }
  inventory?: {
    listSessions: (input?: { tenant_id?: string; page?: number; per_page?: number }) => Promise<{ data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } }>
    createSession: (input: { tenant_id?: string; name: string; created_by?: string | null; created_at?: string | null }) => Promise<any>
    startSession: (sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) => Promise<any>
    deleteSession: (sessionId: string, tenantId?: string) => Promise<any>
    getSession: (sessionId: string, input?: { tenant_id?: string; user_id?: string }) => Promise<any>
    findProduct: (sessionId: string, input: { tenant_id?: string; code?: string; product_id?: string }) => Promise<any>
    count: (sessionId: string, input: any) => Promise<any>
    scan: (sessionId: string, input: any) => Promise<any>
    setItemQty: (sessionId: string, itemId: string, input: { tenant_id?: string; counted_stock: number }) => Promise<any>
    removeItem: (sessionId: string, itemId: string, tenantId?: string) => Promise<{ ok: true }>
    labels: (sessionId: string, tenantId?: string) => Promise<any[]>
    applyPrice: (sessionId: string, input: { tenant_id?: string; product_id: string; retail_price: number }) => Promise<any>
    complete: (sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) => Promise<any>
  }
  orders?: {
    listReady: (input?: { tenant_id?: string; search?: string; customer_id?: string; limit?: number }) => Promise<any[]>
    list?: (input?: any) => Promise<any[]>
    save?: (input: any, id?: string) => Promise<any>
    delete?: (id: string, tenantId?: string) => Promise<{ success: true }>
    updateStatus?: (id: string, status: string, tenantId?: string) => Promise<any>
    updateItemStatus?: (orderId: string, itemId: string, status: string, tenantId?: string) => Promise<any>
    cancel?: (id: string, input?: any) => Promise<any>
    pendingItems?: (supplierId: string, tenantId?: string) => Promise<any[]>
    bulkArrival?: (itemIds: string[], tenantId?: string) => Promise<{ updated: number }>
    get: (id: string, tenantId?: string) => Promise<any | null>
    listPayments: (orderId: string, tenantId?: string) => Promise<any[]>
    listPaymentsByPeriod?: (input?: { date_from?: string; date_to?: string; shift_id?: string }) => Promise<any[]>
    addPayment: (orderId: string, input: any) => Promise<any>
    complete: (orderId: string, input?: any) => Promise<any>
  }
  supply?: {
    listSuppliers?: (input?: any) => Promise<any>
    getSupplier?: (id: string, tenantId?: string) => Promise<any>
    saveSupplier?: (input: any, id?: string) => Promise<any>
    deleteSupplier?: (id: string, tenantId?: string) => Promise<{ ok: true }>
    mergeSuppliers?: (primaryId: string, duplicateId: string, tenantId?: string) => Promise<any>
    getDebts?: (tenantId?: string) => Promise<any>
    listInvoices: (input?: any) => Promise<any>
    getInvoice: (id: string, tenantId?: string) => Promise<any>
    createInvoice: (input: any) => Promise<any>
    createInvoiceFromAi?: (input: { tenant_id?: string; supplier_id?: string | null; supplier_name?: string | null; invoice_number?: string | null; notes?: string | null; rows: Array<Record<string, unknown>> }) => Promise<{
      invoice: any
      matched: number
      created: number
      unresolved: Array<{ name: string; sku: string; needs_barcode: true; needs_category: boolean }>
      draft_items: Array<Record<string, unknown>>
    }>
    updateInvoice: (id: string, input: any) => Promise<any>
    payInvoice: (id: string, input: any) => Promise<any>
    postInvoice: (id: string, input?: any) => Promise<any>
    cancelInvoice: (id: string, tenantId?: string) => Promise<any>
    deleteInvoice: (id: string, tenantId?: string) => Promise<void>
  }
  pos: {
    openShift: (input: { cashier_id: string; opening_cash?: number; notes?: string | null }) => Promise<string>
    getOpenShift: (cashierId: string) => Promise<Shift | null>
    checkout: (input: DesktopCheckoutInput) => Promise<DesktopCheckoutResult>
    listSales?: (input?: any) => Promise<any>
    dashboardSummary?: (input: { tenant_id?: string; date_from: string; date_to: string }) => Promise<any>
    soldItemsReport?: (input: { tenant_id?: string; date_from: string; date_to: string }) => Promise<any[]>
    listReturns?: (input?: any) => Promise<any>
    getReturn?: (id: string, tenantId?: string) => Promise<any>
    getSaleForReturn?: (saleId: string, tenantId?: string) => Promise<any>
    createReturn?: (input: any) => Promise<any>
    getSale?: (id: string, tenantId?: string) => Promise<any>
    calculatePrices?: (items: Array<{ product_id: string; qty: number }>, tenantId?: string) => Promise<any[]>
    suspendSale?: (input: any) => Promise<any>
    listSuspended?: (tenantId?: string) => Promise<any[]>
    resumeSale?: (id: string, tenantId?: string) => Promise<any>
    confirmResumeSale?: (id: string, tenantId?: string) => Promise<any>
    discardSuspendedSale?: (id: string, tenantId?: string) => Promise<any>
    checkSaleAfterPayment?: (shiftId: string, after: string, tenantId?: string) => Promise<any | null>
    listDebtors: (limit?: number) => Promise<Array<{ id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance?: number }>>
    searchCustomers?: (input?: { tenant_id?: string; search?: string; has_debt?: boolean; limit?: number }) => Promise<Array<{ id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance?: number }>>
    listCustomers?: (input?: any) => Promise<any>
    findCustomerByBarcode?: (barcode: string) => Promise<any | null>
    getCustomer?: (id: string, tenantId?: string) => Promise<any>
    getCustomerSales?: (id: string, tenantId?: string) => Promise<any[]>
    saveCustomer?: (input: any, id?: string) => Promise<any>
    deleteCustomer?: (id: string, tenantId?: string) => Promise<{ ok: true }>
    listCustomerVehicles?: (customerId: string, tenantId?: string) => Promise<any[]>
    saveCustomerVehicle?: (customerId: string, input: any, vehicleId?: string) => Promise<any>
    deleteCustomerVehicle?: (customerId: string, vehicleId: string, tenantId?: string) => Promise<{ ok: true }>
    getCustomerDeposit?: (customerId: string, tenantId?: string) => Promise<{ balance: number; transactions: unknown[] }>
    payDebt?: (input: { tenant_id?: string; customer_id: string; amount: number; method: 'cash' | 'card' | 'transfer'; shift_id?: string | null; user_id?: string | null; notes?: string | null }) => Promise<{ data: unknown }>
    addCustomerDeposit?: (input: { tenant_id?: string; customer_id: string; amount: number; method: 'cash' | 'card' | 'transfer'; shift_id?: string | null; user_id?: string | null; notes?: string | null }) => Promise<{ data: { balance: number } }>
    payOutCustomerDeposit?: (input: { tenant_id?: string; customer_id: string; payout_id?: string; amount: number; method: 'cash' | 'card' | 'transfer'; shift_id?: string | null; user_id?: string | null; notes?: string | null }) => Promise<{ data: { balance: number; replayed: boolean } }>
    createCashOperation?: (input: any) => Promise<any>
    listCashOperations?: (shiftId: string, tenantId?: string) => Promise<any[]>
    cashOperationSummary?: (shiftId: string, tenantId?: string) => Promise<any>
    expectedCash: (cashierId: string) => Promise<{ opening_cash: number; cash_sales: number; cash_returns: number; cash_in: number; cash_out: number; expected_amount: number } | null>
    shiftReport: (cashierId: string) => Promise<import('@/types/shift').ShiftReport | null>
    reconcile: (cashierId: string, actualAmount: number, comment: string | null) => Promise<{ ok: true }>
    closeShift: (cashierId: string, actualAmount: number, comment: string | null) => Promise<{ ok: true; id: string }>
  }
  sync: {
    listPending: (limit?: number) => Promise<DesktopSyncOutboxOperation[]>
    getPullState: () => Promise<DesktopSyncPullState>
    status?: () => Promise<DesktopSyncStatus>
    applyPullChanges: (changes: DesktopSyncPullChanges) => Promise<DesktopSyncPullResult>
    markPullFailed: (error: string) => Promise<void>
    applyPushResults: (results: DesktopSyncPushResult[]) => Promise<void>
    markBatchFailed: (sequences: number[], error: string) => Promise<void>
  }
  print: {
    html: (html: string, options?: {
      title?: string
      widthMm?: number
      heightMm?: number
      /** Явний принтер Windows — чеки й етикетки не діляться одним пристроєм. */
      deviceName?: string
      printerRole?: 'receipt' | 'label'
      silent?: boolean
      showPreviewWindow?: boolean
      useDriverPaper?: boolean
      strictPageSize?: boolean
    }) => Promise<{ success: true }>
    listPrinters: () => Promise<Array<{ name: string; displayName: string; isDefault: boolean }>>
    labelsTspl: (html: string, options: {
      printerName: string
      widthMm: number
      heightMm: number
      gapMm?: number
      density?: number
      rotate180?: boolean
    }) => Promise<{ success: true; labels: number }>
  }
  fiscal: {
    pickFolder: (defaultPath?: string) => Promise<string | null>
    getConfig: () => Promise<DesktopFiscalConfig>
    setConfig: (update: DesktopFiscalConfigUpdate) => Promise<DesktopFiscalConfig>
    registerCom: () => Promise<{ registered: boolean }>
    status: () => Promise<DesktopFiscalResult>
    openShift: () => Promise<DesktopFiscalResult>
    closeShift: () => Promise<DesktopFiscalResult>
    xReport: () => Promise<DesktopFiscalResult>
    serviceCash: (amount: number, direction: 'in' | 'out') => Promise<DesktopFiscalResult>
    fiscalizeSale: (request: DesktopFiscalSaleRequest) => Promise<DesktopFiscalSaleIntentResult>
    getSaleIntent: (operationId: string) => Promise<DesktopFiscalSaleIntentResult>
    resolveUnknownSale: (operationId: string, resolution: DesktopFiscalIntentResolution) => Promise<DesktopFiscalSaleIntentResult>
    fiscalizeReturn: (request: DesktopFiscalReturnRequest) => Promise<DesktopFiscalReturnProcessResult>
    listUnresolvedReturns: (scope: DesktopFiscalReturnIntentScope) => Promise<DesktopUnresolvedFiscalReturnIntent[]>
    resumeReturn: (operationId: string, scope: DesktopFiscalReturnIntentScope) => Promise<DesktopFiscalReturnProcessResult>
    resolveUnknownReturn: (operationId: string, resolution: DesktopFiscalReturnIntentResolution) => Promise<DesktopFiscalSaleIntentResult>
    cancelPreparedReturn: (
      operationId: string,
      input: DesktopFiscalReturnIntentCancelInput,
    ) => Promise<{ operation_id: string; cancelled: true }>
  }
}

declare global {
  interface Window {
    forsageDesktop?: ForsageDesktopBridge
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.forsageDesktop)
}

export function desktopBridge(): ForsageDesktopBridge | null {
  return typeof window !== 'undefined' ? window.forsageDesktop ?? null : null
}

function parseDesktopSpecs(product: DesktopProduct): Record<string, string> | null {
  if (!product.specs_json) return null
  try {
    const parsed = JSON.parse(product.specs_json)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
export function desktopProductToProduct(product: DesktopProduct): Product {
  const brandId = product.brand_id ?? null
  const brandName = product.brand_name ?? null
  const categoryId = product.category_id ?? null
  const categoryName = product.category_name ?? null

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    barcode: product.barcode,
    additional_barcodes: null,
    brand_id: brandId,
    category_id: categoryId,
    unit: product.unit,
    purchase_price: product.purchase_price,
    retail_price: product.retail_price,
    qty_on_hand: Number(product.qty_on_hand),
    qty_reserved: Number(product.qty_reserved ?? 0),
    qty_available: Number(product.qty_available ?? product.qty_on_hand),
    reorder_point: Number(product.reorder_point ?? 0),
    notes: product.notes ?? null,
    is_active: product.is_active === 1,
    is_service: product.is_service === 1,
    requires_core_return: product.requires_core_return === 1,
    core_deposit_amount: Number(product.core_deposit_amount ?? 0),
    storage_bin: product.storage_bin,
    is_favorite: product.is_favorite === 1,
    photo_url: product.photo_url ?? null,
    specs: parseDesktopSpecs(product),
    created_at: product.created_at ?? '',
    updated_at: product.updated_at ?? '',
    brand: brandId || brandName ? { id: brandId ?? '', name: brandName ?? '' } : null,
    category: categoryId || categoryName ? { id: categoryId ?? '', name: categoryName ?? '' } : null,
  }
}

export function desktopCheckoutToSale(
  result: DesktopCheckoutResult,
  input: DesktopCheckoutInput,
  receiptItems: Sale['sale_items'],
): Sale {
  const completedAt = new Date().toISOString()
  const cashAmount = input.payments
    .filter((payment) => payment.method === 'cash')
    .reduce((sum, payment) => sum + payment.amount, 0)
  const cardAmount = input.payments
    .filter((payment) => payment.method === 'card')
    .reduce((sum, payment) => sum + payment.amount, 0)

  return {
    id: result.sale_id,
    sale_number: result.sale_number,
    customer_id: input.customer_id ?? null,
    cashier_id: input.cashier_id,
    manager_id: input.manager_id ?? null,
    shift_id: input.shift_id ?? '',
    status: 'completed',
    subtotal: result.subtotal,
    discount: input.discount ?? 0,
    total: result.total,
    payment_method: result.payment_method,
    is_debt: input.payments.some((payment) => payment.method === 'debt'),
    notes: input.notes ?? null,
    completed_at: completedAt,
    is_fiscal: input.is_fiscal === true,
    fiscal_number: input.fiscal_number ?? null,
    fiscal_qr_url: input.fiscal_qr_url ?? null,
    bank_auth_code: input.payments.find((payment) => payment.bank_auth_code)?.bank_auth_code ?? null,
    cash_amount: cashAmount,
    card_amount: cardAmount,
    pickup_cell: null,
    sale_items: receiptItems,
  }
}
