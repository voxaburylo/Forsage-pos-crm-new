import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  createProductSchema,
  updateProductSchema,
  productListSchema,
  posSearchSchema,
} from '../validators/productValidator.js'
import * as productService from '../services/productService.js'

const router = Router()

// Все маршруты требуют авторизации
router.use(requireAuth)

// GET /api/v1/products/search — быстрый поиск для POS (до CRUD чтобы не конфликтовало с /:id)
router.get('/search', async (req, res, next) => {
  try {
    const query = posSearchSchema.safeParse(req.query)
    if (!query.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри пошуку', 400, query.error.flatten())
    const results = await productService.searchForPOS(query.data.q, query.data.limit)
    res.json({ data: results })
  } catch (err) { next(err) }
})

// GET /api/v1/products — список с поиском и фильтрами
router.get('/', async (req, res, next) => {
  try {
    const query = productListSchema.safeParse(req.query)
    if (!query.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, query.error.flatten())
    const result = await productService.listProducts(query.data)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id — карточка товара
router.get('/:id', async (req, res, next) => {
  try {
    const product = await productService.getProduct(String(req.params.id))
    res.json({ data: product })
  } catch (err) { next(err) }
})

// GET /api/v1/products/:id/price-history — история цен
router.get('/:id/price-history', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const history = await productService.getPriceHistory(String(req.params.id))
    res.json({ data: history })
  } catch (err) { next(err) }
})

// POST /api/v1/products — создать товар
router.post('/', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = createProductSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані товару', 422, parsed.error.flatten())
    const product = await productService.createProduct(parsed.data, req.user!.id)
    res.status(201).json({ data: product })
  } catch (err) { next(err) }
})

// PUT /api/v1/products/:id — обновить товар
router.put('/:id', requireRole('owner', 'admin', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = updateProductSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані товару', 422, parsed.error.flatten())
    const product = await productService.updateProduct(String(req.params.id), parsed.data, req.user!.id)
    res.json({ data: product })
  } catch (err) { next(err) }
})

// DELETE /api/v1/products/:id — soft delete
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await productService.deleteProduct(String(req.params.id))
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router

