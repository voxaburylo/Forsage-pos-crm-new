import type { Product } from '@/types/product'
import type { Shift } from '@/types/shift'
import type { Sale } from '@/types/sale'

export interface DesktopRuntimeInfo {
  databasePath: string
  deviceId: string
  schemaVersion: number
  pendingOperations: number
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
  reorder_point?: number
  notes?: string | null
  is_active: number
  is_service: number
  storage_bin: string | null
  is_favorite?: number
  photo_url?: string | null
  specs_json?: string | null
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
  cashier_id: string
  shift_id?: string | null
  customer_id?: string | null
  manager_id?: string | null
  notes?: string | null
  discount?: number
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
  staff?: unknown[]
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
  supply_invoices?: unknown[]
  deleted_supply_invoice_ids?: string[]
  supply_invoice_items?: unknown[]
  supplier_payments?: unknown[]
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
  status: 'synced' | 'failed'
  aggregate_id?: string
  error?: string
}

export interface DesktopSyncPullState {
  cursor: string | null
  last_success_at: string | null
  last_reference_sync_at: string | null
  last_error: string | null
}

export interface DesktopSyncPullChanges {
  tenant_id?: string
  cursor: string
  products?: unknown[]
  deleted_product_ids?: string[]
  customers?: unknown[]
  deleted_customer_ids?: string[]
  suppliers?: unknown[]
  deleted_supplier_ids?: string[]
  categories?: unknown[]
  brands?: unknown[]
  product_barcodes?: unknown[]
  product_aliases?: unknown[]
  product_cross_numbers?: unknown[]
  customer_vehicles?: unknown[]
  customer_orders?: unknown[]
  deleted_customer_order_ids?: string[]
  customer_order_items?: unknown[]
  order_payments?: unknown[]
  supply_invoices?: unknown[]
  deleted_supply_invoice_ids?: string[]
  supply_invoice_items?: unknown[]
  supplier_payments?: unknown[]
  references_included?: boolean
}

export interface DesktopSyncPullResult {
  applied_at: string
  cursor: string
  counts: Record<string, number>
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

interface ForsageDesktopBridge {
  getRuntimeInfo: () => Promise<DesktopRuntimeInfo>
  backupNow: () => Promise<string>
  bootstrap: {
    importSnapshot: (snapshot: DesktopBootstrapSnapshot) => Promise<DesktopBootstrapImportResult>
  }
  catalog: {
    findByBarcode: (barcode: string) => Promise<DesktopProduct | null>
    findById?: (id: string) => Promise<DesktopProduct | null>
    listProducts?: (options?: DesktopCatalogListOptions) => Promise<DesktopCatalogListResult>
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
      is_favorite?: boolean
      barcode?: string | null
      additional_barcodes?: string[]
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
      is_favorite?: boolean
      barcode?: string | null
      additional_barcodes?: string[]
      storage_bin?: string | null
      photo_url?: string | null
      specs?: Record<string, string>
    }) => Promise<DesktopProduct>
    deleteProduct?: (id: string) => Promise<{ ok: true }>
    listPopular: (limit?: number) => Promise<DesktopProduct[]>
  }
  inventory?: {
    listSessions: (input?: { tenant_id?: string }) => Promise<any[]>
    createSession: (input: { tenant_id?: string; name: string; created_by?: string | null; created_at?: string | null }) => Promise<any>
    startSession: (sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) => Promise<any>
    deleteSession: (sessionId: string, tenantId?: string) => Promise<any>
    getSession: (sessionId: string, input?: { tenant_id?: string; user_id?: string }) => Promise<any>
    findProduct: (sessionId: string, input: { tenant_id?: string; code?: string; product_id?: string }) => Promise<any>
    count: (sessionId: string, input: any) => Promise<any>
    scan: (sessionId: string, input: any) => Promise<any>
    setItemQty: (sessionId: string, itemId: string, input: { tenant_id?: string; counted_stock: number }) => Promise<any>
    labels: (sessionId: string, tenantId?: string) => Promise<any[]>
    applyPrice: (sessionId: string, input: { tenant_id?: string; product_id: string; retail_price: number }) => Promise<any>
    complete: (sessionId: string, input?: { tenant_id?: string; user_id?: string | null }) => Promise<any>
  }
  orders?: {
    listReady: (input?: { tenant_id?: string; search?: string; limit?: number }) => Promise<any[]>
    get: (id: string, tenantId?: string) => Promise<any | null>
    listPayments: (orderId: string, tenantId?: string) => Promise<any[]>
    addPayment: (orderId: string, input: any) => Promise<any>
    complete: (orderId: string, input?: any) => Promise<any>
  }
  supply?: {
    listInvoices: (input?: any) => Promise<any>
    getInvoice: (id: string, tenantId?: string) => Promise<any>
    createInvoice: (input: any) => Promise<any>
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
    listDebtors: (limit?: number) => Promise<Array<{ id: string; full_name: string | null; phone: string | null; debt_balance: number }>>
    expectedCash: (cashierId: string) => Promise<{ opening_cash: number; cash_sales: number; cash_returns: number; cash_in: number; cash_out: number; expected_amount: number } | null>
    shiftReport: (cashierId: string) => Promise<import('@/types/shift').ShiftReport | null>
    reconcile: (cashierId: string, actualAmount: number, comment: string | null) => Promise<{ ok: true }>
    closeShift: (cashierId: string, actualAmount: number, comment: string | null) => Promise<{ ok: true; id: string }>
  }
  sync: {
    listPending: (limit?: number) => Promise<DesktopSyncOutboxOperation[]>
    getPullState: () => Promise<DesktopSyncPullState>
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
      silent?: boolean
      showPreviewWindow?: boolean
      useDriverPaper?: boolean
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
    registerCheck: (
      items: DesktopFiscalCheckItem[],
      pay: DesktopFiscalCheckPay,
      comment?: string | null,
    ) => Promise<DesktopFiscalResult>
    registerReturn: (
      items: DesktopFiscalCheckItem[],
      pay: DesktopFiscalCheckPay,
      originalFiscalNumber: string,
    ) => Promise<DesktopFiscalResult>
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
    qty_available: Number(product.qty_on_hand),
    reorder_point: Number(product.reorder_point ?? 0),
    notes: product.notes ?? null,
    is_active: product.is_active === 1,
    is_service: product.is_service === 1,
    storage_bin: product.storage_bin,
    is_favorite: product.is_favorite === 1,
    photo_url: product.photo_url ?? null,
    specs: parseDesktopSpecs(product),
    created_at: '',
    updated_at: '',
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
    fiscal_number: null,
    bank_auth_code: input.payments.find((payment) => payment.bank_auth_code)?.bank_auth_code ?? null,
    cash_amount: cashAmount,
    card_amount: cardAmount,
    pickup_cell: null,
    sale_items: receiptItems,
  }
}
