import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import * as pricingService from '../services/pricingService.js'

const router = Router()
router.use(requireAuth)

// ── Цінові рівні ──────────────────────────────────────────

router.get('/tiers', async (_req, res, next) => {
  try {
    res.json({ data: await pricingService.listPriceTiers() })
  } catch (err) { next(err) }
})

router.post('/tiers', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      name:         z.string().min(1).max(100),
      discount_pct: z.number().min(0).max(100),
      is_default:   z.boolean().optional(),
      sort_order:   z.number().int().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.status(201).json({ data: await pricingService.createPriceTier(parsed.data) })
  } catch (err) { next(err) }
})

router.put('/tiers/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      name:         z.string().min(1).max(100).optional(),
      discount_pct: z.number().min(0).max(100).optional(),
      is_default:   z.boolean().optional(),
      sort_order:   z.number().int().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    res.json({ data: await pricingService.updatePriceTier(String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})

router.delete('/tiers/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await pricingService.deletePriceTier(String(req.params.id))
    res.status(204).send()
  } catch (err) { next(err) }
})

// ── Наценки по категоріях ─────────────────────────────────

router.get('/markups', requireRole('owner', 'admin', 'manager'), async (_req, res, next) => {
  try {
    res.json({ data: await pricingService.listCategoryMarkups() })
  } catch (err) { next(err) }
})

router.put('/markups/:categoryId', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      markup_pct:     z.number().min(0).max(10000),
      min_markup_pct: z.number().min(0).max(10000).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const data = await pricingService.upsertCategoryMarkup(
      String(req.params.categoryId),
      parsed.data.markup_pct,
      parsed.data.min_markup_pct,
    )
    res.json({ data })
  } catch (err) { next(err) }
})

router.delete('/markups/:categoryId', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await pricingService.deleteCategoryMarkup(String(req.params.categoryId))
    res.status(204).send()
  } catch (err) { next(err) }
})

// ── Розрахунок ціни ───────────────────────────────────────

router.post('/calculate', async (req, res, next) => {
  try {
    const schema = z.object({
      purchase_price: z.number().int().min(0),
      retail_price:   z.number().int().min(0),
      category_id:    z.string().uuid().optional(),
      customer_id:    z.string().uuid().optional(),
      quantity:       z.number().positive().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await pricingService.calculatePrice({
      purchasePrice: parsed.data.purchase_price,
      retailPrice:   parsed.data.retail_price,
      categoryId:    parsed.data.category_id,
      customerId:    parsed.data.customer_id,
      quantity:      parsed.data.quantity,
    })
    res.json({ data: result })
  } catch (err) { next(err) }
})

// ── Авто-розрахунок роздрібної ────────────────────────────

router.get('/auto-retail', async (req, res, next) => {
  try {
    const purchase  = parseInt(String(req.query.purchase ?? '0'), 10)
    const categoryId = String(req.query.category_id ?? '')
    const retail    = await pricingService.autoRetailPrice(purchase, categoryId || undefined)
    res.json({ data: { retail_price: retail } })
  } catch (err) { next(err) }
})

export default router
