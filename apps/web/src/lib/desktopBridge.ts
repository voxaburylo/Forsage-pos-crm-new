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
  unit: string
  purchase_price: number
  retail_price: number
  qty_on_hand: number
  is_active: number
  is_service: number
  storage_bin: string | null
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
    searchProducts: (query: string, limit?: number) => Promise<DesktopProduct[]>
    upsertProduct: (product: {
      id: string
      sku: string
      name: string
      unit?: string
      retail_price?: number
      purchase_price?: number
      qty_on_hand?: number
      is_service?: boolean
      is_active?: boolean
      barcode?: string | null
    }) => Promise<DesktopProduct>
    listPopular: (limit?: number) => Promise<DesktopProduct[]>
  }
  pos: {
    openShift: (input: { cashier_id: string; opening_cash?: number; notes?: string | null }) => Promise<string>
    getOpenShift: (cashierId: string) => Promise<Shift | null>
    checkout: (input: DesktopCheckoutInput) => Promise<DesktopCheckoutResult>
    listDebtors: (limit?: number) => Promise<Array<{ id: string; full_name: string | null; phone: string | null; debt_balance: number }>>
    expectedCash: (cashierId: string) => Promise<{ opening_cash: number; cash_sales: number; cash_returns: number; cash_in: number; cash_out: number; expected_amount: number } | null>
    reconcile: (cashierId: string, actualAmount: number, comment: string | null) => Promise<{ ok: true }>
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
      useDriverPaper?: boolean
    }) => Promise<{ success: true }>
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

export function desktopProductToProduct(product: DesktopProduct): Product {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    barcode: product.barcode,
    additional_barcodes: null,
    brand_id: null,
    category_id: null,
    unit: product.unit,
    purchase_price: product.purchase_price,
    retail_price: product.retail_price,
    qty_on_hand: Number(product.qty_on_hand),
    qty_available: Number(product.qty_on_hand),
    reorder_point: 0,
    notes: null,
    is_active: product.is_active === 1,
    is_service: product.is_service === 1,
    storage_bin: product.storage_bin,
    is_favorite: false,
    photo_url: null,
    specs: null,
    created_at: '',
    updated_at: '',
    brand: null,
    category: null,
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
