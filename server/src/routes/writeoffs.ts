import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { writeoffListSchema, createWriteoffSchema } from '../validators/writeoffSchema.js'
import { listWriteoffs, getWriteoff, createWriteoff } from '../services/writeoffService.js'

const router = Router()
router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const q = writeoffListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    res.json(await listWriteoffs(q.data))
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ data: await getWriteoff(String(req.params.id)) })
  } catch (err) { next(err) }
})

router.post('/', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = createWriteoffSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const data = await createWriteoff(req.user!.id, req.user!.tenant_id, parsed.data)
    res.status(201).json({ data })
  } catch (err) { next(err) }
})

export default router
