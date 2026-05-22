import { Router } from 'express'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { AppError } from '../middleware/errorHandler.js'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/supabase.js'
import { loginSchema } from '../validators/authSchema.js'
import { logger } from '../lib/logger.js'

const router = Router()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } },
)

// Телефон → внутрішній email (те саме що на фронтенді)
function phoneToEmail(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@forsage.internal`
}

// POST /api/v1/auth/login — вхід по телефону + паролю
router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Невірні дані', 422)
    }

    const { phone, password } = parsed.data
    const email = phoneToEmail(phone)

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    if (error || !data.session) {
      logger.warn({ phone }, 'Failed login attempt')
      throw new AppError('INVALID_CREDENTIALS', 'Невірний номер телефону або пароль', 401)
    }

    logger.info({ userId: data.user.id }, 'User logged in')

    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      user: {
        id: data.user.id,
        phone,
        role: data.user.user_metadata?.role ?? 'cashier',
      },
    })
  } catch (err) { next(err) }
})

// POST /api/v1/auth/refresh — оновити access token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body
    if (!refresh_token) throw new AppError('VALIDATION_ERROR', 'refresh_token обов\'язковий', 422)

    const { data, error } = await supabase.auth.refreshSession({ refresh_token })
    if (error || !data.session) throw new AppError('INVALID_TOKEN', 'Недійсний refresh token', 401)

    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
    })
  } catch (err) { next(err) }
})

// POST /api/v1/auth/logout — вихід
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    logger.info({ userId: req.user?.id }, 'User logged out')
    res.status(204).send()
  } catch (err) { next(err) }
})

// GET /api/v1/auth/me — поточний користувач
router.get('/me', requireAuth, (req, res) => {
  res.json({ data: req.user })
})

// POST /api/v1/auth/verify-pin — перевірка PIN-коду
router.post('/verify-pin', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({ pin: z.string().min(4).max(4) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.json({ data: { valid: false } })

    const { data: stored, error } = await db
      .from('staff_pins')
      .select('pin_code')
      .eq('user_id', req.user!.id)
      .maybeSingle()

    if (error) {
      // Якщо таблиця недоступна — дозволяємо вхід
      return res.json({ data: { valid: true } })
    }

    if (!stored) {
      // PIN не встановлено — дозволяємо будь-який 4-значний код
      return res.json({ data: { valid: true } })
    }

    const valid = stored.pin_code === parsed.data.pin
    res.json({ data: { valid } })
  } catch (err) { next(err) }
})

// POST /api/v1/auth/set-pin — встановити PIN-код
router.post('/set-pin', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      pin: z.string().length(4, 'PIN має містити рівно 4 цифри'),
      user_id: z.string().uuid().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний PIN', 422, parsed.error.flatten())

    const targetUserId = parsed.data.user_id ?? req.user!.id
    if (targetUserId !== req.user!.id && !['owner', 'admin'].includes(req.user!.role)) {
      throw new AppError('FORBIDDEN', 'Недостатньо прав', 403)
    }

    await db.from('staff_pins').upsert({
      user_id: targetUserId,
      pin_code: parsed.data.pin,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// POST /api/v1/auth/change-password — зміна пароля (свій або будь-який для owner/admin)
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      user_id:  z.string().uuid().optional(),  // чий пароль міняємо (опціонально — свій)
      password: z.string().min(4, 'Мінімум 4 символи'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const targetUserId = parsed.data.user_id ?? req.user!.id

    // Якщо міняємо не собі — перевіряємо права
    if (targetUserId !== req.user!.id && !['owner', 'admin'].includes(req.user!.role)) {
      throw new AppError('FORBIDDEN', 'Тільки адмін може змінювати паролі іншим', 403)
    }

    const { error } = await supabase.auth.admin.updateUserById(targetUserId, {
      password: parsed.data.password,
    })

    if (error) throw new AppError('AUTH_ERROR', error.message, 500)
    logger.info({ userId: req.user!.id, targetUserId }, 'Password changed')
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
