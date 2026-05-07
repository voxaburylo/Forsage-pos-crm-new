import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { openShiftSchema, closeShiftSchema } from '../validators/shiftSchema.js'
import * as shiftService from '../services/shiftService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/shifts/current — поточна відкрита зміна
router.get('/current', async (req, res, next) => {
  try {
    const shift = await shiftService.getCurrentShift(req.user!.id)
    res.json({ data: shift })
  } catch (err) { next(err) }
})

// POST /api/v1/shifts/open — відкрити зміну
router.post('/open', async (req, res, next) => {
  try {
    const parsed = openShiftSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть початковий залишок готівки', 422, parsed.error.flatten())
    const shift = await shiftService.openShift(req.user!.id, parsed.data)
    res.status(201).json({ data: shift })
  } catch (err) { next(err) }
})

// POST /api/v1/shifts/:id/close — закрити зміну
router.post('/:id/close', async (req, res, next) => {
  try {
    const parsed = closeShiftSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть фактичний залишок готівки', 422, parsed.error.flatten())
    const shift = await shiftService.closeShift(String(req.params.id), req.user!.id, parsed.data)
    res.json({ data: shift })
  } catch (err) { next(err) }
})

// GET /api/v1/shifts/:id — деталі зміни
router.get('/:id', async (req, res, next) => {
  try {
    const shift = await shiftService.getShift(String(req.params.id))
    res.json({ data: shift })
  } catch (err) { next(err) }
})

// GET /api/v1/shifts/:id/report — звіт по зміні
router.get('/:id/report', async (req, res, next) => {
  try {
    const report = await shiftService.getShiftReport(String(req.params.id))
    res.json({ data: report })
  } catch (err) { next(err) }
})

export default router
