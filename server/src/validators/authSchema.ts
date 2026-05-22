import { z } from 'zod'

const phoneRegex = /^\+?380\d{9}$/

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

export const loginSchema = z.object({
  phone: z
    .string()
    .min(1, 'Телефон обов\'язковий')
    .transform(normalizePhone)
    .refine((v) => phoneRegex.test(v), 'Невірний формат телефону (+380XXXXXXXXX)'),
  password: z
    .string()
    .min(4, 'Пароль мінімум 4 символи'),
})

export type LoginInput = z.infer<typeof loginSchema>
