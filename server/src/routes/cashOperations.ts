import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createCashOperationSchema, cashOpListSchema } from '../validators/cashOperationSchema.js'
import * as cashOpService from '../services/cashOperationService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/cash-operations/summary?shift_id= — ПЕРЕД /:id
router.get('/summary', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const shiftId = String(req.query.shift_id ?? '')
    if (!shiftId) throw new AppError('VALIDATION_ERROR', 'Потрібен shift_id', 400)
    const summary = await cashOpService.getShiftCashSummary(shiftId)
    res.json({ data: summary })
  } catch (err) { next(err) }
})

// GET /api/v1/cash-operations?shift_id=
router.get('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const q = cashOpListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await cashOpService.listCashOperations(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/v1/cash-operations — body: { shift_id, type, amount, note }
router.post('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = createCashOperationSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const shiftId = String(req.body.shift_id ?? '')

    const userRole = req.user!.role ?? 'cashier'
    const op = await cashOpService.createCashOperation(parsed.data, shiftId || null, req.user!.id, userRole, req.user!.tenant_id)
    res.status(201).json({ data: op })
  } catch (err) { next(err) }
})

export default router
