import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  createCustomerSchema, updateCustomerSchema,
  customerListSchema, payDebtSchema, quickCreateSchema,
} from '../validators/customerSchema.js'
import * as customerService from '../services/customerService.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/customers — список з пошуком
router.get('/', async (req, res, next) => {
  try {
    const q = customerListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await customerService.listCustomers(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/customers/:id — картка клієнта
router.get('/:id', async (req, res, next) => {
  try {
    const customer = await customerService.getCustomer(String(req.params.id))
    res.json({ data: customer })
  } catch (err) { next(err) }
})

// GET /api/v1/customers/:id/sales — історія покупок
router.get('/:id/sales', async (req, res, next) => {
  try {
    const sales = await customerService.getCustomerSales(String(req.params.id))
    res.json({ data: sales })
  } catch (err) { next(err) }
})

// GET /api/v1/customers/:id/debts — продажі в борг (историяч долгов)
router.get('/:id/debts', async (req, res, next) => {
  try {
    const debts = await customerService.getCustomerDebts(String(req.params.id))
    res.json({ data: debts })
  } catch (err) { next(err) }
})

// POST /api/v1/customers — створити клієнта
router.post('/', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = createCustomerSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані клієнта', 422, parsed.error.flatten())
    const customer = await customerService.createCustomer(parsed.data)
    res.status(201).json({ data: customer })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/quick — швидке створення з POS (тільки телефон + ім'я)
router.post('/quick', requireRole('owner', 'admin', 'manager', 'cashier'), async (req, res, next) => {
  try {
    const parsed = quickCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Введіть телефон та ім\'я', 422, parsed.error.flatten())
    const customer = await customerService.createCustomer({ ...parsed.data, tags: [] })
    res.status(201).json({ data: customer })
  } catch (err) { next(err) }
})

// PUT /api/v1/customers/:id — оновити клієнта
router.put('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = updateCustomerSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані клієнта', 422, parsed.error.flatten())
    const customer = await customerService.updateCustomer(String(req.params.id), parsed.data)
    res.json({ data: customer })
  } catch (err) { next(err) }
})

// POST /api/v1/customers/:id/pay-debt — погасити борг
router.post('/:id/pay-debt', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = payDebtSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Вкажіть коректну суму', 422, parsed.error.flatten())
    const customer = await customerService.payDebt(String(req.params.id), parsed.data)
    res.json({ data: customer })
  } catch (err) { next(err) }
})

// DELETE /api/v1/customers/:id — soft delete
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await customerService.deleteCustomer(String(req.params.id))
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
