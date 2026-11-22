import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { TILL_ROLES } from '../services/tillCommandService.js'
import { WEB_RPC_ROLES, callTill, claimRpc, finishRpc, rpcRequestSchema, rpcResultSchema } from '../services/tillRpcService.js'

/** Веб працює через головний ПК (рішення власника 22.11.2026). Див. tillRpcService. */
export const tillRpcRouter = Router()
tillRpcRouter.use(requireAuth)

tillRpcRouter.post('/', requireRole(...WEB_RPC_ROLES), async (req, res, next) => {
  try {
    const parsed = rpcRequestSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректний запит до каси', 422)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await callTill(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

// Каса: забрати запити вебу й відповісти. Лише програма на касі (заголовок каси перевіряє localFirstWriteGuard).
tillRpcRouter.post('/claim', requireRole(...TILL_ROLES), async (req, res, next) => {
  try { res.json({ data: await claimRpc(req.user!.tenant_id, String(req.body?.device_id ?? '')) }) } catch (err) { next(err) }
})

tillRpcRouter.post('/:id/result', requireRole(...TILL_ROLES), async (req, res, next) => {
  try {
    const parsed = rpcResultSchema.safeParse(req.body?.outcome)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректна відповідь каси', 422)
    res.json({ data: await finishRpc(req.user!.tenant_id, String(req.body?.device_id ?? ''), String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})
