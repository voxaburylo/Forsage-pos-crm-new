import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import * as commissionService from '../services/commissionService.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin'))

const createRuleSchema = z.object({
  user_id: z.string().uuid().nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  pct_from_revenue: z.number().min(0).max(100).default(0),
  pct_from_profit: z.number().min(0).max(100).default(0),
})

// GET /api/v1/commission/rules
router.get('/rules', async (req, res, next) => {
  try {
    const rules = await commissionService.listCommissionRules(req.user!.tenant_id)
    res.json({ data: rules })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/commission/rules
router.post('/rules', async (req, res, next) => {
  try {
    const parsed = createRuleSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Некоректні дані правила', 422, parsed.error.flatten())
    }
    const rule = await commissionService.createCommissionRule(parsed.data, req.user!.tenant_id)
    res.status(201).json({ data: rule })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/commission/rules/:id
router.delete('/rules/:id', async (req, res, next) => {
  try {
    await commissionService.deleteCommissionRule(req.params.id, req.user!.tenant_id)
    res.status(204).send()
  } catch (err) {
    next(err)
  }
})

export default router
