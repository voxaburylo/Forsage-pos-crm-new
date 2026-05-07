import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { AppError } from '../middleware/errorHandler.js'
import { requireAuth } from '../middleware/auth.js'
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

export default router
