import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { createSaleSchema, calculatePriceSchema, saleListSchema } from '../validators/saleSchema.js'
import * as saleService from '../services/saleService.js'

const router = Router()
router.use(requireAuth)

// POST /api/v1/sales/calculate-price — розрахунок ціни (до /:id щоб не конфліктувати)
router.post('/calculate-price', async (req, res, next) => {
  try {
    const parsed = calculatePriceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await saleService.calculatePrice(parsed.data)
    res.json({ data: result })
  } catch (err) { next(err) }
})

// GET /api/v1/sales — список продажів
router.get('/', async (req, res, next) => {
  try {
    const q = saleListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await saleService.listSales(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/sales/:id — деталі продажу
router.get('/:id', async (req, res, next) => {
  try {
    const sale = await saleService.getSale(String(req.params.id))
    res.json({ data: sale })
  } catch (err) { next(err) }
})

// POST /api/v1/sales — створити продаж
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSaleSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані продажу', 422, parsed.error.flatten())
    const sale = await saleService.createSale(req.user!.id, parsed.data)
    res.status(201).json({ data: sale })
  } catch (err) { next(err) }
})

export default router
