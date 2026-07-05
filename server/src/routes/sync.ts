import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { getSyncChanges } from '../services/syncService.js'

const router = Router()
router.use(requireAuth)

const querySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
})

router.get('/changes', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Некоректний курсор синхронізації', 400)
    }
    const data = await getSyncChanges({
      since: parsed.data.since,
      tenantId: req.user!.tenant_id,
      role: req.user!.role,
    })
    res.json({ data })
  } catch (error) {
    next(error)
  }
})

export default router
