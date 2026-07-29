import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { getBootstrapSnapshot, getSyncChanges, pushLocalOperations } from '../services/syncService.js'

const router = Router()
router.use(requireAuth)

const querySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  include_references: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
})

const pushSchema = z.object({
  operations: z.array(z.object({
    sequence: z.number().int().positive(),
    operation_id: z.string().min(1),
    tenant_id: z.string().uuid(),
    device_id: z.string().min(1),
    aggregate_type: z.string().min(1),
    aggregate_id: z.string().min(1),
    operation_type: z.string().min(1),
    payload: z.any(),
    created_at: z.string().datetime({ offset: true }),
  })).max(100),
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
      userId: req.user!.id,
      role: req.user!.role,
      includeReferences: parsed.data.include_references,
    })
    res.json({ data })
  } catch (error) {
    next(error)
  }
})

router.get('/bootstrap', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const data = await getBootstrapSnapshot(req.user!.tenant_id)
    res.json({ data })
  } catch (error) {
    next(error)
  }
})

router.post('/push', async (req, res, next) => {
  try {
    const parsed = pushSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Некоректний пакет синхронізації', 400)
    }
    const data = await pushLocalOperations({
      tenantId: req.user!.tenant_id,
      userId: req.user!.id,
      role: req.user!.role,
      operations: parsed.data.operations.map((operation) => ({
        ...operation,
        payload: operation.payload ?? {},
      })),
    })
    res.json({ data })
  } catch (error) {
    next(error)
  }
})

export default router
