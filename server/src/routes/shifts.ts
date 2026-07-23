import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { openShiftSchema, closeShiftSchema } from '../validators/shiftSchema.js'
import { db } from '../db/supabase.js'
import * as shiftService from '../services/shiftService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/shifts/current — поточна відкрита зміна
router.get('/current', async (req, res, next) => {
  try {
    const shift = await shiftService.getCurrentShift(req.user!.id, req.user!.tenant_id)
    res.json({ data: shift })
  } catch (err) { next(err) }
})

// POST /api/v1/shifts/open — відкрити зміну
router.post('/open', async (req, res, next) => {
  try {
    const parsed = openShiftSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть початковий залишок готівки', 422, parsed.error.flatten())
    const shift = await shiftService.openShift(req.user!.id, req.user!.tenant_id, parsed.data)
    res.status(201).json({ data: shift })
  } catch (err) { next(err) }
})

// POST /api/v1/shifts/:id/close — закрити зміну
router.post('/:id/close', async (req, res, next) => {
  try {
    const parsed = closeShiftSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть фактичний залишок готівки', 422, parsed.error.flatten())
    const shift = await shiftService.closeShift(String(req.params.id), req.user!.id, parsed.data, req.user!.tenant_id, req.user!.role)
    res.json({ data: shift })
  } catch (err) { next(err) }
})

// GET /api/v1/shifts/current/expected-cash — розрахунок очікуваної готівки
router.get('/current/expected-cash', async (req, res, next) => {
  try {
    const shift = await shiftService.getCurrentShift(req.user!.id, req.user!.tenant_id)
    if (!shift) throw new AppError('NO_SHIFT', 'Зміну не відкрито', 400)

    const breakdown = await shiftService.getShiftCashBreakdown(
      shift.id,
      req.user!.tenant_id,
      shift.opening_cash,
    )
    res.json({ data: breakdown })
  } catch (err) { next(err) }
})

// POST /api/v1/shifts/current/reconcile — зберегти звірку каси
router.post('/current/reconcile', async (req, res, next) => {
  try {
    const shift = await shiftService.getCurrentShift(req.user!.id, req.user!.tenant_id)
    if (!shift) throw new AppError('NO_SHIFT', 'Зміну не відкрито', 400)

    const schema = z.object({
      actual_amount: z.number().int().min(0),
      comment: z.string().max(2000).optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна сума', 422)

    const breakdown = await shiftService.getShiftCashBreakdown(
      shift.id,
      req.user!.tenant_id,
      shift.opening_cash,
    )
    const expected = breakdown.expected_amount
    const difference = parsed.data.actual_amount - expected

    const { data, error } = await db.from('cash_reconciliations').insert({
      tenant_id: req.user!.tenant_id, shift_id: shift.id, user_id: req.user!.id,
      expected_amount: expected, actual_amount: parsed.data.actual_amount,
      difference_amount: difference, comment: parsed.data.comment ?? null,
    }).select().single()

    if (error) throw new AppError('DB_ERROR', error.message, 500)

    // Audit log
    await db.from('audit_log').insert({
      tenant_id: req.user!.tenant_id, user_id: req.user!.id,
      action: 'CASH_RECONCILIATION', entity_type: 'shifts',
      entity_id: shift.id,
      details: { expected_amount: expected, actual_amount: parsed.data.actual_amount, difference },
    })

    res.status(201).json({ data })
  } catch (err) { next(err) }
})

// GET /api/v1/shifts/:id — деталі зміни
router.get('/:id', async (req, res, next) => {
  try {
    const shift = await shiftService.getShift(String(req.params.id), req.user!.tenant_id)
    res.json({ data: shift })
  } catch (err) { next(err) }
})

// GET /api/v1/shifts/:id/report — звіт по зміні
router.get('/:id/report', async (req, res, next) => {
  try {
    const report = await shiftService.getShiftReport(String(req.params.id), req.user!.tenant_id)
    res.json({ data: report })
  } catch (err) { next(err) }
})

export default router
