import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import * as loyaltyService from '../services/loyaltyService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/loyalty/settings
router.get('/settings', async (_req, res, next) => {
  try {
    res.json({ data: await loyaltyService.getSettings() })
  } catch (err) { next(err) }
})

// PUT /api/v1/loyalty/settings
router.put('/settings', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      is_enabled:           z.boolean().optional(),
      accrual_pct:          z.number().min(0).max(100).optional(),
      max_redeem_pct:       z.number().min(0).max(100).optional(),
      expiry_days:          z.number().int().positive().nullable().optional(),
      min_purchase_kopecks: z.number().int().min(0).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await loyaltyService.updateSettings(parsed.data) })
  } catch (err) { next(err) }
})

// GET /api/v1/loyalty/customer/:id — баланс і транзакції
router.get('/customer/:id', async (req, res, next) => {
  try {
    const customerId = String(req.params.id)
    const [balance, transactions, settings] = await Promise.all([
      loyaltyService.getBalance(customerId),
      loyaltyService.getTransactions(customerId),
      loyaltyService.getSettings(),
    ])
    res.json({ data: { balance, transactions, settings } })
  } catch (err) { next(err) }
})

// GET /api/v1/loyalty/customer/:id/max-redeem?total=
router.get('/customer/:id/max-redeem', async (req, res, next) => {
  try {
    const customerId = String(req.params.id)
    const total = parseInt(String(req.query.total) || '0', 10)
    const balance    = await loyaltyService.getBalance(customerId)
    const maxAllowed = await loyaltyService.maxRedeem(total)
    res.json({ data: { balance, max_redeem: Math.min(balance, maxAllowed) } })
  } catch (err) { next(err) }
})

// POST /api/v1/loyalty/customer/:id/redeem
router.post('/customer/:id/redeem', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const schema = z.object({
      amount:  z.number().int().positive(),
      sale_id: z.string().uuid().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    await loyaltyService.redeemBonus({
      customerId: String(req.params.id),
      amount:     parsed.data.amount,
      saleId:     parsed.data.sale_id,
      userId:     req.user!.id,
    })
    res.json({ data: { success: true } })
  } catch (err) { next(err) }
})

export default router
