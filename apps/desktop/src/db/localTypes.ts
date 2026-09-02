export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001'

export interface LocalProduct {
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
  is_active: number
  is_service: number
  requires_core_return?: number
  core_deposit_amount?: number
  storage_bin: string | null
  created_at?: string
  updated_at?: string
}

export interface LocalProductUpsert {
  id: string
  tenant_id?: string
  sku: string
  name: string
  barcode?: string | null
  brand_id?: string | null
  category_id?: string | null
  unit?: string
  purchase_price?: number
  retail_price?: number
  qty_on_hand?: number
  reorder_point?: number
  notes?: string | null
  is_active?: boolean
  is_service?: boolean
  requires_core_return?: boolean
  core_deposit_amount?: number
  storage_bin?: string | null
  is_favorite?: boolean
  photo_url?: string | null
  specs?: Record<string, string>
  additional_barcodes?: string[]
  /** Explicit stock correction; ordinary product edits must not change stock. */
  stock_correction?: boolean
  /** Крос-номери/аналоги (повний список). undefined = не чіпати; [] = очистити. */
  cross_numbers?: string[]
}

export interface LocalSalePaymentInput {
  method: 'cash' | 'card' | 'debt' | 'transfer'
  amount: number
  is_fiscal?: boolean
  fiscal_number?: string | null
  bank_auth_code?: string | null
  terminal_rrn?: string | null
}

export interface LocalSaleItemInput {
  product_id?: string | null
  description?: string | null
  qty: number
  unit_price?: number
  discount?: number
}

export interface LocalSaleCheckoutInput {
  client_operation_id?: string
  tenant_id?: string
  cashier_id: string
  shift_id?: string | null
  customer_id?: string | null
  manager_id?: string | null
  items: LocalSaleItemInput[]
  payments: LocalSalePaymentInput[]
  discount?: number
  bonuses_spent?: number
  notes?: string | null
  is_fiscal?: boolean
  fiscal_number?: string | null
  fiscal_qr_url?: string | null
}

export interface LocalSaleCheckoutResult {
  sale_id: string
  sale_number: string
  total: number
  subtotal: number
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  outbox_sequence: number | bigint
}

export interface LocalFiscalCheckItem {
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

export interface LocalFiscalCheckPay {
  cash: number
  card: number
  bank?: number
  check_total: number
  auth_code?: string | null
  rrn?: string | null
  customer_email?: string | null
}

export type LocalFiscalSaleIntentState =
  | 'prepared'
  | 'fiscalizing'
  | 'fiscalized'
  | 'unknown'
  | 'completed'

export interface LocalFiscalSaleRequest {
  operation_id: string
  checkout: LocalSaleCheckoutInput
  items: LocalFiscalCheckItem[]
  pay: LocalFiscalCheckPay
  comment?: string | null
}

export interface LocalFiscalReturnRequest {
  operation_id: string
  return_input: Record<string, unknown>
  items: LocalFiscalCheckItem[]
  pay: LocalFiscalCheckPay
  original_fiscal_number: string
}

export interface LocalFiscalSaleIntentResult {
  operation_id: string
  state: LocalFiscalSaleIntentState
  payload_hash: string
  fiscal_result: Record<string, unknown> | null
  checkout_result: LocalSaleCheckoutResult | null
  last_error: string | null
}

export interface LocalFiscalIntentResolution {
  cashalot_checked: boolean
  confirmed_by: string
  reason: string
}

export interface LocalFiscalReturnIntentScope {
  tenant_id?: string
  cashier_id: string
}

export interface LocalFiscalReturnIntentResolution extends LocalFiscalIntentResolution, LocalFiscalReturnIntentScope {}

export interface LocalFiscalReturnIntentCancelInput extends LocalFiscalReturnIntentScope {
  confirmed_by: string
  reason: string
}

export interface LocalUnresolvedFiscalReturnIntent {
  operation_id: string
  tenant_id: string
  cashier_id: string
  state: Exclude<LocalFiscalSaleIntentState, 'completed'>
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

export interface LocalBootstrapSnapshot {
  exported_at: string
  tenant_id: string
  reset_required?: boolean
  reset_generation?: number
  reset_at?: string | null
  staff?: any[]
  staff_pins?: any[]
  categories?: any[]
  brands?: any[]
  suppliers?: any[]
  products?: any[]
  product_barcodes?: any[]
  product_aliases?: any[]
  product_cross_numbers?: any[]
  customers?: any[]
  customer_vehicles?: any[]
  customer_orders?: any[]
  deleted_customer_order_ids?: string[]
  customer_order_items?: any[]
  order_payments?: any[]
  shifts?: any[]
  sales?: any[]
  sale_items?: any[]
  commission_rules?: any[]
  salary_payments?: any[]
  deleted_salary_payment_ids?: string[]
  cash_operations?: any[]
  deleted_cash_operation_ids?: string[]
  customer_returns?: any[]
  customer_return_items?: any[]
  stock_reserves?: any[]
  warehouse_movements?: any[]
  writeoffs?: any[]
  writeoff_items?: any[]
  bonus_transactions?: any[]
  customer_deposit_transactions?: any[]
  supply_invoices?: any[]
  deleted_supply_invoice_ids?: string[]
  supply_invoice_items?: any[]
  supplier_payments?: any[]
  supplier_price_items?: any[]
  supplier_price_imports?: any[]
  inventory_sessions?: any[]
  deleted_inventory_session_ids?: string[]
  inventory_items?: any[]
  shop_settings?: any
  counts?: Record<string, number>
}

export interface LocalBootstrapImportResult {
  imported_at: string
  tenant_id: string
  counts: {
    staff: number
    staff_pins: number
    deleted_staff: number
    categories: number
    deleted_categories: number
    brands: number
    deleted_brands: number
    suppliers: number
    products: number
    product_barcodes: number
    product_aliases: number
    product_cross_numbers: number
    customers: number
    customer_vehicles: number
    customer_orders: number
    deleted_customer_orders: number
    customer_order_items: number
    order_payments: number
    shifts: number
    sales: number
    sale_items: number
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
    supply_invoices: number
    deleted_supply_invoices: number
    supply_invoice_items: number
    supplier_payments: number
    inventory_sessions: number
    deleted_inventory_sessions: number
    inventory_items: number
    supplier_price_items: number
    supplier_price_imports: number
    settings: number
  }
}

export interface LocalSyncOutboxOperation {
  sequence: number
  operation_id: string
  tenant_id: string
  device_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload: any
  created_at: string
  attempts: number
  last_error: string | null
}

/**
 * Застрягла операція для екрана «Не синхронізовано». Без payload — для показу
 * людині вистачає типу, часу й помилки, а payload накладної важить сотні КБ.
 */
export interface LocalSyncStuckOperation {
  sequence: number
  operation_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  created_at: string
  attempts: number
  last_error: string | null
}

/**
 * Джерело проблеми. Каса працює автономно, тому мусить сама пам'ятати, що в неї
 * зламалось, — інакше збій видно лише в консолі розробника, якої на касі немає.
 */
export type LocalProblemSource = 'sync' | 'print' | 'fiscal' | 'database' | 'app'

export interface LocalProblem {
  id: string
  source: LocalProblemSource
  code: string
  severity: 'error' | 'warning'
  title: string
  detail: string | null
  entity_type: string | null
  entity_id: string | null
  context: Record<string, unknown> | null
  occurrences: number
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
}

export interface LocalProblemInput {
  source: LocalProblemSource
  code: string
  title: string
  severity?: 'error' | 'warning'
  detail?: string | null
  entity_type?: string | null
  entity_id?: string | null
  context?: Record<string, unknown> | null
  tenant_id?: string
}

export interface LocalProblemSummary {
  errors: number
  warnings: number
  last_seen_at: string | null
}

export interface LocalSyncPushResult {
  sequence: number
  operation_id: string
  status: 'synced' | 'failed' | 'discarded'
  aggregate_id?: string
  error?: string
  error_code?: 'SYNC_RESET_REQUIRED'
  reset_generation?: number
  reset_at?: string
}

export interface LocalSyncPullState {
  cursor: string | null
  reset_generation: number
  last_success_at: string | null
  last_reference_sync_at: string | null
  last_error: string | null
}

export interface LocalSyncPullChanges {
  tenant_id?: string
  cursor: string
  reset_required?: boolean
  reset_generation?: number
  reset_at?: string | null
  staff?: any[]
  staff_directory?: any[]
  staff_pins?: any[]
  products?: any[]
  deleted_product_ids?: string[]
  customers?: any[]
  deleted_customer_ids?: string[]
  suppliers?: any[]
  deleted_supplier_ids?: string[]
  categories?: any[]
  brands?: any[]
  product_barcodes?: any[]
  deleted_product_barcode_ids?: string[]
  product_aliases?: any[]
  deleted_product_alias_ids?: string[]
  product_cross_numbers?: any[]
  deleted_product_cross_number_ids?: string[]
  customer_vehicles?: any[]
  deleted_customer_vehicle_ids?: string[]
  deleted_category_ids?: string[]
  deleted_brand_ids?: string[]
  customer_orders?: any[]
  deleted_customer_order_ids?: string[]
  customer_order_items?: any[]
  order_payments?: any[]
  shifts?: any[]
  sales?: any[]
  sale_items?: any[]
  commission_rules?: any[]
  salary_payments?: any[]
  deleted_salary_payment_ids?: string[]
  cash_operations?: any[]
  deleted_cash_operation_ids?: string[]
  customer_returns?: any[]
  customer_return_items?: any[]
  stock_reserves?: any[]
  warehouse_movements?: any[]
  writeoffs?: any[]
  writeoff_items?: any[]
  bonus_transactions?: any[]
  customer_deposit_transactions?: any[]
  supply_invoices?: any[]
  deleted_supply_invoice_ids?: string[]
  supply_invoice_items?: any[]
  supplier_payments?: any[]
  supplier_price_items?: any[]
  supplier_price_imports?: any[]
  inventory_sessions?: any[]
  deleted_inventory_session_ids?: string[]
  inventory_items?: any[]
  shop_settings?: any
  references_included?: boolean
  catalog_structure_snapshot_included?: boolean
  staff_snapshot_included?: boolean
  staff_directory_snapshot_included?: boolean
  commission_rules_snapshot_included?: boolean
  salary_payments_snapshot_included?: boolean
  stock_reserves_snapshot_included?: boolean
}

export interface LocalSyncPullResult {
  applied_at: string
  cursor: string
  counts: {
    staff: number
    staff_pins: number
    products: number
    deleted_products: number
    customers: number
    deleted_customers: number
    suppliers: number
    deleted_suppliers: number
    product_barcodes: number
    product_aliases: number
    product_cross_numbers: number
    customer_vehicles: number
    customer_orders: number
    deleted_customer_orders: number
    customer_order_items: number
    order_payments: number
    shifts: number
    sales: number
    sale_items: number
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
    supply_invoices: number
    deleted_supply_invoices: number
    supply_invoice_items: number
    supplier_payments: number
    categories: number
    deleted_categories: number
    brands: number
    deleted_brands: number
    deleted_staff: number
    inventory_sessions: number
    deleted_inventory_sessions: number
    inventory_items: number
    supplier_price_items: number
    supplier_price_imports: number
    settings: number
  }
}
