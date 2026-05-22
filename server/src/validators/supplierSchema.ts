import { z } from 'zod'

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return "+" + digits
  if (digits.startsWith('80'))  return "+3" + digits
  if (digits.startsWith('0'))   return "+38" + digits
  return raw
}

const phoneSchema = z.string().min(1).transform(normalizePhone).refine((v) => /^\+?380\d{9}$/.test(v))

// Suppliers
export const supplierListSchema = z.object({
  search:    z.string().optional(),
  is_active: z.enum(['true', 'false']).optional(),
  page:      z.coerce.number().int().positive().default(1),
  per_page:  z.coerce.number().int().positive().max(500).default(20),
})

export const createSupplierSchema = z.object({
  name:         z.string().min(1).max(300),
  phone:        phoneSchema.optional().nullable(),
  email:        z.string().email().max(255).optional().nullable(),
  contact_name: z.string().max(200).optional().nullable(),
  notes:        z.string().max(2000).optional().nullable(),
})

export const updateSupplierSchema = createSupplierSchema.partial()

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>
export type SupplierListQuery   = z.infer<typeof supplierListSchema>

// Supply invoices
export const supplyInvoiceItemSchema = z.object({
  product_id:     z.string().uuid(),
  qty:            z.number().positive(),
  purchase_price: z.number().int().min(0),
  total:          z.number().int().min(0),
})

export const createSupplyInvoiceSchema = z.object({
  supplier_id:    z.string().uuid().optional().nullable(),
  invoice_number: z.string().max(100).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
  items:          z.array(supplyInvoiceItemSchema).min(1),
})

export const updateSupplyInvoiceSchema = z.object({
  invoice_number: z.string().max(100).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
})

export const supplyInvoiceListSchema = z.object({
  status:      z.enum(['draft', 'posted', 'cancelled']).optional(),
  supplier_id: z.string().uuid().optional(),
  page:        z.coerce.number().int().positive().default(1),
  per_page:    z.coerce.number().int().positive().max(100).default(20),
})

export type CreateSupplyInvoiceInput = z.infer<typeof createSupplyInvoiceSchema>
export type UpdateSupplyInvoiceInput = z.infer<typeof updateSupplyInvoiceSchema>
export type SupplyInvoiceListQuery   = z.infer<typeof supplyInvoiceListSchema>