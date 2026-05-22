import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createReturnSchema, returnListSchema } from '../validators/returnSchema.js'
import * as returnService from '../services/returnService.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager'))

// GET /api/v1/returns — список повернень
router.get('/', async (req, res, next) => {
  try {
    const q = returnListSchema.safeParse(req.query)
    if (!q.success) {
      throw new AppError('VALIDATION_ERROR', 'Nevirni parametry', 400, q.error.flatten())
    }
    const result = await returnService.listReturns(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/returns/sale/:saleId/items — позиції чека (СТАТИЧНИЙ перед /:id)
router.get('/sale/:saleId/items', async (req, res, next) => {
  try {
    const result = await returnService.getSaleItems(String(req.params.saleId))
    res.json({ data: result })
  } catch (err) { next(err) }
})

// GET /api/v1/returns/:id — деталі повернення
router.get('/:id', async (req, res, next) => {
  try {
    const ret = await returnService.getReturn(String(req.params.id))
    res.json({ data: ret })
  } catch (err) { next(err) }
})

// POST /api/v1/returns — оформити повернення
router.post('/', async (req, res, next) => {
  try {
    const parsed = createReturnSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Nevirni dani povernennia', 422, parsed.error.flatten())
    }
    const ret = await returnService.createReturn(req.user!.id, req.user!.tenant_id, parsed.data)
    res.status(201).json({ data: ret })
  } catch (err) { next(err) }
})

export default router