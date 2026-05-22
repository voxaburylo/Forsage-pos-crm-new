import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'
import { initMessengers, stopMessengers } from '../services/messengers/MessengerService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/channels — список каналів
router.get('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('messenger_channels')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

// POST /api/v1/channels — створити канал
router.post('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      platform: z.enum(['telegram', 'viber', 'whatsapp']),
      name: z.string().min(1).max(200),
      credentials: z.object({ token: z.string().min(1) }),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { data, error } = await db
      .from('messenger_channels')
      .insert({
        tenant_id: req.user!.tenant_id,
        platform: parsed.data.platform,
        name: parsed.data.name,
        credentials: parsed.data.credentials,
        is_active: true,
      })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Перезапускаємо ботів
    stopMessengers()
    initMessengers()

    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// PUT /api/v1/channels/:id — оновити канал
router.put('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      is_active: z.boolean().optional(),
      name: z.string().min(1).max(200).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const { data, error } = await db
      .from('messenger_channels')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error || !data) throw new AppError('NOT_FOUND', 'Канал не знайдено', 404)

    // Перезапускаємо ботів
    stopMessengers()
    initMessengers()

    res.json({ data })
  } catch (err) { next(err) }
})

// DELETE /api/v1/channels/:id — видалити канал
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { error } = await db
      .from('messenger_channels')
      .delete()
      .eq('id', req.params.id)

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Перезапускаємо ботів
    stopMessengers()
    initMessengers()

    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
