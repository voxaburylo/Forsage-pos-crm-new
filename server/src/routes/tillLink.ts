import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { TILL_ROLES } from '../services/tillCommandService.js'
import { tillBeat } from '../services/tillLinkService.js'

/** Зв'язок головного ПК із сервером: «я на зв'язку, чи є для мене робота». Див. tillLinkService. */
export const tillLinkRouter = Router()
tillLinkRouter.use(requireAuth)

// Лише програма на касі (заголовок каси перевіряє localFirstWriteGuard).
tillLinkRouter.post('/beat', requireRole(...TILL_ROLES), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await tillBeat(req.user!.tenant_id, String(req.body?.device_id ?? '')) })
  } catch (err) { next(err) }
})
