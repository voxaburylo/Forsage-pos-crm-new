import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { db } from '../db/supabase.js'

const router = Router()
router.use(requireAuth)

const createSchema = z.object({
  document_type: z.enum(['receipt', 'label', 'order', 'picking_list', 'other']),
  document_id:   z.string().uuid().optional().nullable(),
  title:         z.string().min(1).max(300),
  copies:        z.number().int().min(1).max(50).default(1),
})

// POST /api/v1/print — створити задачу друку
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 400, parsed.error.flatten())

    const { data, error } = await db
      .from('print_jobs')
      .insert({
        tenant_id:     req.user!.tenant_id,
        document_type: parsed.data.document_type,
        document_id:   parsed.data.document_id ?? null,
        title:         parsed.data.title,
        copies:        parsed.data.copies,
        status:        'printed',
        printed_at:    new Date().toISOString(),
        printed_by:    req.user!.id,
      })
      .select()
      .single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/print/jobs — список задач
router.get('/jobs', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500)
    const docType = req.query.document_type as string | undefined

    let q = db
      .from('print_jobs')
      .select('*')
      .eq('tenant_id', req.user!.tenant_id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (docType) q = q.eq('document_type', docType)

    const { data, error } = await q
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    res.json({ data: data ?? [] })
  } catch (err) { next(err) }
})

export default router
