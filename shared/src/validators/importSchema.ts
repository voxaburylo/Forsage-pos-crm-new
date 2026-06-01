import { z } from 'zod'

export const columnMappingSchema = z.object({
  sku: z.number().int().min(0).optional().nullable(),
  name: z.number().int().min(0).optional().nullable(),
  qty: z.number().int().min(0).optional().nullable(),
  price: z.number().int().min(0).optional().nullable(),
  retail_price: z.number().int().min(0).optional().nullable(),
  barcode: z.number().int().min(0).optional().nullable(),
  storage_bin: z.number().int().min(0).optional().nullable(),
})

export const parseImportSchema = z.object({
  text:        z.string().min(1).max(2_000_000),
  supplier_id: z.string().uuid().optional().nullable(),
})

export const previewImportSchema = z.object({
  text: z.string().min(1).max(2_000_000),
  mapping: columnMappingSchema,
  supplier_id: z.string().uuid().optional().nullable(),
})

export const parsedItemSchema = z.object({
  row:           z.number().int().positive(),
  sku:           z.string().optional().default(''),
  name:          z.string().min(1),
  qty:           z.number().min(0),
  price:         z.number().int().min(0),
  retail_price:  z.number().int().min(0).optional().nullable(),
  barcode:       z.string().optional().nullable(),
  storage_bin:   z.string().optional().nullable(),
  matched:       z.boolean(),
  product_id:    z.string().uuid().optional().nullable(),
  match_quality: z.enum(['exact', 'fuzzy', 'new']).optional(),
  warnings:      z.array(z.string()).optional().default([]),
})

export const confirmImportSchema = z.object({
  supplier_id:    z.string().uuid().optional().nullable(),
  invoice_number: z.string().max(100).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
  items:          z.array(parsedItemSchema).min(1),
  create_missing: z.boolean().optional().default(false),
  mode:           z.enum(['replace', 'add']).optional().default('replace'),
  update_retail:  z.boolean().optional().default(true),
})

export type ColumnMapping     = z.infer<typeof columnMappingSchema>
export type ParseImportInput   = z.infer<typeof parseImportSchema>
export type PreviewImportInput = z.infer<typeof previewImportSchema>
export type ConfirmImportInput = z.infer<typeof confirmImportSchema>
export type ParsedItem         = z.infer<typeof parsedItemSchema>

