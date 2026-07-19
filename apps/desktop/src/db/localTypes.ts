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
  is_active: number
  is_service: number
  storage_bin: string | null
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
  storage_bin?: string | null
  is_favorite?: boolean
  photo_url?: string | null
  specs?: Record<string, string>
  additional_barcodes?: string[]
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
  tenant_id?: string
  cashier_id: string
  shift_id?: string | null
  customer_id?: string | null
  manager_id?: string | null
  items: LocalSaleItemInput[]
  payments: LocalSalePaymentInput[]
  discount?: number
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

export interface LocalBootstrapSnapshot {
  exported_at: string
  tenant_id: string
  staff?: any[]
  categories?: any[]
  brands?: any[]
  suppliers?: any[]
  products?: any[]
  product_barcodes?: any[]
  product_aliases?: any[]
  product_cross_numbers?: any[]
  customers?: any[]
  customer_vehicles?: any[]
  counts?: Record<string, number>
}

export interface LocalBootstrapImportResult {
  imported_at: string
  tenant_id: string
  counts: {
    staff: number
    categories: number
    brands: number
    suppliers: number
    products: number
    product_barcodes: number
    product_aliases: number
    product_cross_numbers: number
    customers: number
    customer_vehicles: number
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

export interface LocalSyncPushResult {
  sequence: number
  operation_id: string
  status: 'synced' | 'failed'
  error?: string
}

export interface LocalSyncPullState {
  cursor: string | null
  last_success_at: string | null
  last_reference_sync_at: string | null
  last_error: string | null
}

export interface LocalSyncPullChanges {
  tenant_id?: string
  cursor: string
  products?: any[]
  deleted_product_ids?: string[]
  customers?: any[]
  deleted_customer_ids?: string[]
  suppliers?: any[]
  deleted_supplier_ids?: string[]
  categories?: any[]
  brands?: any[]
  product_barcodes?: any[]
  product_aliases?: any[]
  product_cross_numbers?: any[]
  customer_vehicles?: any[]
  references_included?: boolean
}

export interface LocalSyncPullResult {
  applied_at: string
  cursor: string
  counts: {
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
    categories: number
    brands: number
  }
}
