import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/notifications/inbox — непрочитані сповіщення для поточного юзера
router.get('/inbox', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
    const { data, error } = await db
      .from('in_app_notifications')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('user_id', req.user!.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// GET /api/v1/notifications/inbox/count — лічильник непрочитаних
router.get('/inbox/count', async (req, res, next) => {
  try {
    const { count, error } = await db
      .from('in_app_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', req.user!.tenant_id)
      .eq('user_id', req.user!.id)
      .eq('is_read', false)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { count: count ?? 0 } })
  } catch (err) { next(err) }
})

// PATCH /api/v1/notifications/inbox/:id/read — відмітити прочитаним
router.patch('/inbox/:id/read', async (req, res, next) => {
  try {
    const { error } = await db
      .from('in_app_notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user!.id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// PATCH /api/v1/notifications/inbox/read-all — відмітити всі прочитаними
router.patch('/inbox/read-all', async (req, res, next) => {
  try {
    const { error } = await db
      .from('in_app_notifications')
      .update({ is_read: true })
      .eq('tenant_id', req.user!.tenant_id)
      .eq('user_id', req.user!.id)
      .eq('is_read', false)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

// GET /api/v1/notifications/templates — список шаблонів
router.get('/templates', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('notification_templates')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .order('event_type')

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// PUT /api/v1/notifications/templates/:id — оновити шаблон
router.put('/templates/:id', async (req, res, next) => {
  try {
    const { title_template, body_template, is_active } = req.body
    const { data, error } = await db
      .from('notification_templates')
      .update({ title_template, body_template, is_active })
      .eq('id', req.params.id)
      .eq('tenant_id', req.user!.tenant_id)
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/notifications/preferences/:customerId — отримати уподобання клієнта
router.get('/preferences/:customerId', async (req, res, next) => {
  try {
    const { customerId } = req.params
    const { data, error } = await db
      .from('customer_notification_preferences')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .eq('customer_id', customerId)

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// PUT /api/v1/notifications/preferences/:customerId — оновити уподобання клієнта
router.put('/preferences/:customerId', async (req, res, next) => {
  try {
    const { customerId } = req.params
    const { preferences } = req.body

    if (!Array.isArray(preferences)) {
      throw new AppError('VALIDATION_ERROR', 'preferences must be an array', 400)
    }

    const rows = preferences.map((p: any) => ({
      tenant_id: req.user!.tenant_id,
      customer_id: customerId,
      channel: p.channel,
      event_type: p.event_type,
      is_enabled: !!p.is_enabled,
      updated_at: new Date().toISOString()
    }))

    // Upsert into customer_notification_preferences
    const { data, error } = await db
      .from('customer_notification_preferences')
      .upsert(rows, { onConflict: 'tenant_id,customer_id,channel,event_type' })
      .select()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

export default router
