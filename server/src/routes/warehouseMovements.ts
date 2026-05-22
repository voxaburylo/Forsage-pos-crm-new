import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { MovementService } from '../services/movementService.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager', 'storekeeper'))


// Список переміщень
const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(100).default(50),
  product_id: z.string().uuid().optional(),
})

router.get('/', async (req, res, next) => {
  try {
    const q = listSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())

    const { page, per_page, product_id } = q.data
    const result = await MovementService.listMovements({
      tenantId: req.user!.tenant_id,
      page,
      perPage: per_page,
      productId: product_id,
    })

    res.json({
      data: result.data,
      pagination: {
        page,
        per_page,
        total: result.total,
        total_pages: Math.ceil(result.total / per_page),
      },
    })
  } catch (err) { next(err) }
})

// Створити переміщення
const createSchema = z.object({
  product_id: z.string().uuid(),
  qty: z.number().positive(),
  from_bin: z.string().max(100).optional().nullable(),
  to_bin: z.string().min(1).max(100),
  note: z.string().max(500).optional().nullable(),
})

router.post('/', async (req, res, next) => {
  try {
    const body = createSchema.safeParse(req.body)
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 400, body.error.flatten())

    const userId = (req as any).userId as string
    const result = await MovementService.createMovement({
      tenantId: req.user!.tenant_id,
      productId: body.data.product_id,
      qty: body.data.qty,
      fromBin: body.data.from_bin,
      toBin: body.data.to_bin,
      movedBy: userId,
      note: body.data.note,
    })

    res.status(201).json({ data: result })
  } catch (err) { next(err) }
})

export default router
