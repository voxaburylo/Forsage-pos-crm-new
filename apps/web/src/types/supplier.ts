export interface Supplier {
  id: string
  name: string
  phone: string | null
  email: string | null
  contact_name: string | null
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SupplierFormData {
  name: string
  phone: string
  email: string
  contact_name: string
  notes: string
}

export interface SupplyInvoiceItem {
  id: string
  invoice_id: string
  product_id: string
  qty: number
  purchase_price: number
  total: number
  product?: { id: string; sku: string; name: string; unit: string; retail_price: number; barcode: string | null } | null
}

export type SupplyInvoiceStatus = 'draft' | 'posted' | 'cancelled'

export interface SupplyInvoice {
  id: string
  supplier_id: string | null
  invoice_number: string | null
  status: SupplyInvoiceStatus
  total: number
  notes: string | null
  posted_by: string | null
  posted_at: string | null
  created_at: string
  updated_at: string
  supplier?: { id: string; name: string } | null
  items?: SupplyInvoiceItem[]
}

export interface PaginatedSuppliers {
  data: Supplier[]
  pagination: { page: number; per_page: number; total: number; total_pages: number }
}

export interface PaginatedInvoices {
  data: SupplyInvoice[]
  pagination: { page: number; per_page: number; total: number; total_pages: number }
}