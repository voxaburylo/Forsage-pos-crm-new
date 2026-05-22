import { z } from 'zod'

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

const phoneSchema = z
  .string()
  .min(1, 'Телефон обов\'язковий')
  .transform(normalizePhone)
  .refine((v) => /^\+?380\d{9}$/.test(v), 'Невірний формат телефону (+380XXXXXXXXX)')

export const createCustomerSchema = z.object({
  phone:         phoneSchema,
  full_name:     z.string().max(200).optional().nullable(),
  email:         z.string().email('Невірний email').max(255).optional().nullable(),
  notes:         z.string().max(2000).optional().nullable(),
  tags:          z.array(z.string()).default([]),
  price_tier_id: z.string().uuid().optional().nullable(),
  vip_level:     z.enum(['standard','bronze','silver','gold']).optional(),
  risk_profile:  z.enum(['low','medium','high']).optional(),
})

export const quickCreateSchema = z.object({
  phone:     phoneSchema,
  full_name: z.string().min(1, 'Ім\'я обов\'язкове').max(200),
})

export const updateCustomerSchema = createCustomerSchema.partial()

export const customerListSchema = z.object({
  search:   z.string().optional(),
  has_debt: z.enum(['true', 'false']).optional(),
  tag:      z.string().optional(),
  group_id: z.string().uuid().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
})

export const payDebtSchema = z.object({
  amount:   z.number().int().positive('Сума має бути більше 0'),
  method:   z.enum(['cash', 'card']).optional().default('cash'),
  shift_id: z.string().uuid().optional().nullable(),
  note:     z.string().max(500).optional(),
})

export type CreateCustomerInput  = z.infer<typeof createCustomerSchema>
export type UpdateCustomerInput  = z.infer<typeof updateCustomerSchema>
export type CustomerListQuery    = z.infer<typeof customerListSchema>
export type PayDebtInput         = z.infer<typeof payDebtSchema>
