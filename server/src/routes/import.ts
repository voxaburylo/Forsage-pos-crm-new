import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import * as importController from '../controllers/importController.js'

const router = Router()
router.use(requireAuth)

const ALLOWED = ['owner', 'admin', 'manager', 'cashier', 'storekeeper'] as const

router.post('/parse', requireRole(...ALLOWED), importController.parse)
router.post('/preview', requireRole(...ALLOWED), importController.preview)
router.post('/confirm', requireRole(...ALLOWED), importController.confirm)

export default router
