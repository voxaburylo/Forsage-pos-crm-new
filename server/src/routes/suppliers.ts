import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  supplierListSchema, createSupplierSchema, updateSupplierSchema,
  supplyInvoiceListSchema, createSupplyInvoiceSchema, updateSupplyInvoiceSchema,
  invoicePaymentSchema, saveSupplyInvoiceDraftSchema,
} from '../validators/supplierSchema.js'
import * as supplierService from '../services/supplierService.js'

const router = Router()
router.use(requireAuth)
const SUPPLIER_ROLES = ['owner', 'admin', 'manager', 'storekeeper'] as const
const RECEIVING_ROLES = ['owner', 'admin', 'manager', 'cashier', 'storekeeper'] as const
// Касир може приймати товар і швидко створити постачальника прямо з накладної.
// Редагування, злиття, видалення та перегляд боргів лишаються для складу.
router.use((req, res, next) => {
  const isInvoiceRoute = req.path === '/invoices' || req.path.startsWith('/invoices/')
  const isQuickCreate = req.method === 'POST' && req.path === '/'
  return requireRole(...(isInvoiceRoute || isQuickCreate ? RECEIVING_ROLES : SUPPLIER_ROLES))(req, res, next)
})

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

// POST /api/v1/suppliers/invoices/draft — фонове збереження спільної чернетки з веб-накладної
router.post('/invoices/draft', requireRole(...RECEIVING_ROLES), async (req, res, next) => {
  try {
    const parsed = saveSupplyInvoiceDraftSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна чернетка накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.saveSupplyInvoiceDraft(req.user!.id, parsed.data, req.user!.tenant_id)
    res.status(parsed.data.invoice_id ? 200 : 201).json({ data: invoice })
  } catch (err) { next(err) }
})

// GET /api/v1/suppliers/invoices/draft/latest — остання серверна чернетка веб-приймання
router.get('/invoices/draft/latest', requireRole(...RECEIVING_ROLES), async (req, res, next) => {
  try {
    const invoice = await supplierService.getLatestSupplyInvoiceDraft(req.user!.tenant_id)
    res.json({ data: invoice })
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
router.post('/invoices', requireRole(...RECEIVING_ROLES), async (req, res, next) => {
  try {
    const parsed = createSupplyInvoiceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.createSupplyInvoice(req.user!.id, parsed.data, req.user!.tenant_id)
    res.status(201).json({ data: invoice })
  } catch (err) { next(err) }
})

// PUT /api/v1/suppliers/invoices/:id
router.put('/invoices/:id', requireRole(...RECEIVING_ROLES), async (req, res, next) => {
  try {
    const parsed = updateSupplyInvoiceSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані накладної', 422, parsed.error.flatten())
    const invoice = await supplierService.updateSupplyInvoice(String(req.params.id), parsed.data, req.user!.tenant_id, req.user!.id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/post — проведення
router.post('/invoices/:id/post', requireRole(...RECEIVING_ROLES), async (req, res, next) => {
  try {
    const invoice = await supplierService.postSupplyInvoice(String(req.params.id), req.user!.id, req.user!.tenant_id)
    res.json({ data: invoice })
  } catch (err) { next(err) }
})

// POST /api/v1/suppliers/invoices/:id/pay — доплата постачальнику
router.post('/invoices/:id/pay', requireRole('owner', 'admin', 'manager', 'cashier', 'storekeeper'), async (req, res, next) => {
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
router.delete('/invoices/:id', requireRole('owner', 'admin', 'cashier'), async (req, res, next) => {
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
router.post('/', requireRole(...RECEIVING_ROLES), async (req, res, next) => {
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
