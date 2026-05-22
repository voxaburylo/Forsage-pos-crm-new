import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin'))

const listSchema = z.object({
  entity_type: z.string().optional(),
  user_id:     z.string().uuid().optional(),
  date_from:   z.string().optional(),
  date_to:     z.string().optional(),
  page:        z.coerce.number().int().positive().default(1),
  per_page:    z.coerce.number().int().positive().max(100).default(50),
})

router.get('/', async (req, res, next) => {
  try {
    const q = listSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())

    const { entity_type, user_id, date_from, date_to, page, per_page } = q.data
    const offset = (page - 1) * per_page

    let query = db
      .from('audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + per_page - 1)

    if (entity_type) query = query.eq('entity_type', entity_type)
    if (user_id)     query = query.eq('user_id', user_id)
    if (date_from)   query = query.gte('created_at', date_from + 'T00:00:00.000Z')
    if (date_to)     query = query.lte('created_at', date_to + 'T23:59:59.999Z')

    const { data, error, count } = await query
    if (error) throw new AppError('DB_ERROR', error.message, 500)

    res.json({
      data: data ?? [],
      pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
    })
  } catch (err) { next(err) }
})

export default router
