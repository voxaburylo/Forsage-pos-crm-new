import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  supplierListSchema, createSupplierSchema, updateSupplierSchema,
  supplyInvoiceListSchema, createSupplyInvoiceSchema, updateSupplyInvoiceSchema,
  invoicePaymentSchema,
} from '../validators/supplierSchema.js'
import * as supplierService from '../services/supplierService.js'

const router = Router()
router.use(requireAuth)

// ===================== Приходні накладні =====================

// GET /api/v1/suppliers/invoices
router.get('/invoices', async (req, res, next) => {
  try {
    const q = supplyInvoiceListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await supplierService.listSupplyInvoices(q.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/suppliers/invoices/:id
router.get('/invoices/:id', async (req, res, next) => {
  try {
    const invoice = await supplierService.getSupplyInvoice(String(req.params.id), req.user!.tenant_id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices
router.post('/invoices', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const parsed = createSupplyInvoiceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.createSupplyInvoice(req.user!.id, parsed.data, req.user!.tenant_id)
    res.status(201).json({ data: invoice })
  } catch (err) { next(err) }
})

// PUT /api/v1/suppliers/invoices/:id
router.put('/invoices/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = updateSupplyInvoiceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.updateSupplyInvoice(String(req.params.id), parsed.data, req.user!.tenant_id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/post — проведення
router.post('/invoices/:id/post', requireRole('owner', 'admin', 'manager', 'storekeeper'), async (req, res, next) => {
  try {
    const invoice = await supplierService.postSupplyInvoice(String(req.params.id), req.user!.id, req.user!.tenant_id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/pay — доплата постачальнику
router.post('/invoices/:id/pay', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = invoicePaymentSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна сума оплати', 422, parsed.error.flatten())
    const invoice = await supplierService.addInvoicePayment(
      String(req.params.id), parsed.data.amount, parsed.data.payment_method,
      parsed.data.fund_source, parsed.data.shift_id ?? null, parsed.data.note ?? null,
      req.user!.id, req.user!.tenant_id,
    )
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/cancel — скасування
router.post('/invoices/:id/cancel', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const invoice = await supplierService.cancelSupplyInvoice(String(req.params.id), req.user!.tenant_id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// DELETE /api/v1/suppliers/invoices/:id
router.delete('/invoices/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await supplierService.deleteSupplyInvoice(String(req.params.id), req.user!.tenant_id)
    res.status(204).send()
  } catch (err) { next(err) }
})

// ===================== Постачальники =====================

// GET /api/v1/suppliers/debts — борги перед постачальниками (ДО /:id!)
router.get('/debts', async (req, res, next) => {
  try {
    const result = await supplierService.getSupplierDebts(req.user!.tenant_id)
    res.json({ data: result })
  } catch (err) { next(err) }
})

// GET /api/v1/suppliers
router.get('/', async (req, res, next) => {
  try {
    const q = supplierListSchema.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 400, q.error.flatten())
    const result = await supplierService.listSuppliers(q.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/v1/suppliers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const supplier = await supplierService.getSupplier(String(req.params.id), req.user!.tenant_id)
    res.json({ data: supplier })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers
router.post('/', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = createSupplierSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані постачальника', 422, parsed.error.flatten())
    const supplier = await supplierService.createSupplier(parsed.data, req.user!.tenant_id)
    res.status(201).json({ data: supplier })
  } catch (err) { next(err) }
})

// PUT /api/v1/suppliers/:id
router.put('/:id', requireRole('owner', 'admin', 'manager'), async (req, res, next) => {
  try {
    const parsed = updateSupplierSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані постачальника', 422, parsed.error.flatten())
    const supplier = await supplierService.updateSupplier(String(req.params.id), parsed.data, req.user!.tenant_id)
    res.json({ data: supplier })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/merge — злиття дублікатів
router.post('/merge', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      primary_supplier_id: z.string().uuid(),
      duplicate_supplier_id: z.string().uuid(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const supplier = await supplierService.mergeSuppliers(
      parsed.data.primary_supplier_id, parsed.data.duplicate_supplier_id, req.user!.tenant_id,
    )
    res.json({ data: supplier })
  } catch (err) { next(err) }
})

// DELETE /api/v1/suppliers/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await supplierService.deleteSupplier(String(req.params.id), req.user!.tenant_id)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
