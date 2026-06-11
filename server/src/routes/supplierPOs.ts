import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { listSupplierPOs, updateSupplierPOStatus } from '../services/supplierService.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager', 'storekeeper'))

// GET /api/v1/supplier-pos — список замовлень постачальникам
router.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const data = await listSupplierPOs(req.user!.tenant_id, status)
    res.json({ data })
  } catch (err) { next(err) }
})

// PATCH /api/v1/supplier-pos/:id/status — змінити статус PO
router.patch('/:id/status', async (req, res, next) => {
  try {
    const schema = z.object({ status: z.enum(['ordered', 'received', 'cancelled']) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний статус', 422)

    const data = await updateSupplierPOStatus(req.params.id, parsed.data.status, req.user!.tenant_id)
    res.json({ data })
  } catch (err) { next(err) }
})

export default router
