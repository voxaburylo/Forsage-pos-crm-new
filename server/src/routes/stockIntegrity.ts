import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { StockValidatorService } from '../services/stockValidatorService.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin'))

/**
 * GET /api/v1/admin/stock-integrity
 * Повертає список товарів з від'ємним залишком (qty_on_hand < 0)
 */
router.get('/', async (req, res, next) => {
  try {
    const tenantId = req.user!.tenant_id
    const result = await StockValidatorService.runIntegrityCheck(tenantId)

    res.json({
      data: result.issues,
      count: result.count,
      checked_at: new Date().toISOString(),
      status: result.count === 0 ? 'ok' : 'issues_found',
    })
  } catch (err) { next(err) }
})

export default router
