import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  supplierListSchema, createSupplierSchema, updateSupplierSchema,
  supplyInvoiceListSchema, createSupplyInvoiceSchema, updateSupplyInvoiceSchema,
} from '../validators/supplierSchema.js'
import * as supplierService from '../services/supplierService.js'

const router = Router()
router.use(requireAuth)

// ===================== Приходні накладні =====================
// ВАЖЛИВО: /invoices/* маршрути ВИЩЕ /:id — інакше Express перехопить 'invoices' як :id

// GET /api/v1/suppliers/invoices
router.get('/invoices', async (req, res, next) => {
  try {
    const q = supplyInvoiceListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await supplierService.listSupplyInvoices(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/suppliers/invoices/:id
router.get('/invoices/:id', async (req, res, next) => {
  try {
    const invoice = await supplierService.getSupplyInvoice(String(req.params.id))
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices
router.post('/invoices', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = createSupplyInvoiceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.createSupplyInvoice(req.user!.id, parsed.data)
    res.status(201).json({ data: invoice })
  } catch (err) { next(err) }
})

// PUT /api/v1/suppliers/invoices/:id
router.put('/invoices/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = updateSupplyInvoiceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.updateSupplyInvoice(String(req.params.id), parsed.data)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/post — проведення
router.post('/invoices/:id/post', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const invoice = await supplierService.postSupplyInvoice(String(req.params.id), req.user!.id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/cancel — скасування
router.post('/invoices/:id/cancel', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const invoice = await supplierService.cancelSupplyInvoice(String(req.params.id))
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// DELETE /api/v1/suppliers/invoices/:id
router.delete('/invoices/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await supplierService.deleteSupplyInvoice(String(req.params.id))
    res.status(204).send()
  } catch (err) { next(err) }
})

// ===================== Постачальники =====================

// GET /api/v1/suppliers
router.get('/', async (req, res, next) => {
  try {
    const q = supplierListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await supplierService.listSuppliers(q.data)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/suppliers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const supplier = await supplierService.getSupplier(String(req.params.id))
    res.json({ data: supplier })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers
router.post('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = createSupplierSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані постачальника', 422, parsed.error.flatten())
    const supplier = await supplierService.createSupplier(parsed.data)
    res.status(201).json({ data: supplier })
  } catch (err) { next(err) }
})

// PUT /api/v1/suppliers/:id
router.put('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = updateSupplierSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані постачальника', 422, parsed.error.flatten())
    const supplier = await supplierService.updateSupplier(String(req.params.id), parsed.data)
    res.json({ data: supplier })
  } catch (err) { next(err) }
})

// DELETE /api/v1/suppliers/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await supplierService.deleteSupplier(String(req.params.id))
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
