import { z } from 'zod'

// --- Users ---
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

const phoneSchema = z
  .string().min(1, 'Телефон обов\'язковий')
  .transform(normalizePhone)
  .refine((v) => /^\+?380\d{9}$/.test(v), 'Невірний формат (+380XXXXXXXXX)')

export const createUserSchema = z.object({
  phone:    phoneSchema,
  password: z.string().min(6, 'Пароль мінімум 6 символів'),
  full_name: z.string().min(1).max(200),
  role:     z.enum(['owner','admin','manager','cashier','storekeeper','sto_viewer']),
})

export const updateUserSchema = z.object({
  role:      z.enum(['owner','admin','manager','cashier','storekeeper','sto_viewer']).optional(),
  is_active: z.boolean().optional(),
  full_name: z.string().min(1).max(200).optional(),
})

// --- Categories ---
export const categorySchema = z.object({
  name:       z.string().min(1).max(200),
  parent_id:  z.string().uuid().optional().nullable(),
  sort_order: z.number().int().min(0).default(0),
})

// --- Brands ---
export const brandSchema = z.object({
  name:    z.string().min(1).max(200),
  country: z.string().max(100).optional().nullable(),
})

// --- Settings ---
export const settingsSchema = z.object({
  shop_name:          z.string().min(1).max(200).optional(),
  shop_address:       z.string().max(500).optional().nullable(),
  phone:              z.string().max(30).optional().nullable(),
  max_discount_pct:   z.number().min(0).max(100).optional(),
  allow_negative_qty: z.boolean().optional(),
  return_days:        z.number().int().min(1).max(365).optional(),
})

export type CreateUserInput  = z.infer<typeof createUserSchema>
export type UpdateUserInput  = z.infer<typeof updateUserSchema>
export type CategoryInput    = z.infer<typeof categorySchema>
export type BrandInput       = z.infer<typeof brandSchema>
export type SettingsInput    = z.infer<typeof settingsSchema>
