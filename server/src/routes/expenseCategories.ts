import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await db.from('expense_categories').select('*').eq('tenant_id', req.user!.tenant_id).order('name')
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

router.post('/', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({ name: z.string().min(1).max(200) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна назва', 422)
    const { data, error } = await db.from('expense_categories').insert({ tenant_id: req.user!.tenant_id, name: parsed.data.name }).select().single()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

export default router
