import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { readSystemStatus } from '../services/systemStatusService.js'

/**
 * 23.11.2026 (план T2): «Стан системи» для власника й адміністратора — чи на зв'язку каса, версія, вікно чи фон,
 * черга передачі, копії бази, місце на диску, помилки сервера за добу. Лише читання.
 */
export const systemRouter = Router()
systemRouter.use(requireAuth)

systemRouter.get('/status', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await readSystemStatus(req.user!.tenant_id) })
  } catch (err) { next(err) }
})
