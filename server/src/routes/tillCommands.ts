import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  TILL_ROLES, WEB_COMMAND_ROLES, claimCommands, commandResultSchema, createCommand, createCommandSchema, finishCommand, readCommand, tillStatus,
} from '../services/tillCommandService.js'

/** Запис із вебу через касу: веб ставить команду, каса її забирає й виконує у своїй базі. */
export const tillCommandsRouter = Router()
tillCommandsRouter.use(requireAuth)

tillCommandsRouter.get('/status', requireRole(...WEB_COMMAND_ROLES), async (req, res, next) => {
  try { res.json({ data: await tillStatus(req.user!.tenant_id) }) } catch (err) { next(err) }
})

tillCommandsRouter.post('/', requireRole(...WEB_COMMAND_ROLES), async (req, res, next) => {
  try {
    const parsed = createCommandSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректна зміна. Оновіть сторінку й спробуйте ще раз.', 422)
    res.status(202).json({ data: await createCommand(req.user!.tenant_id, req.user!.id, parsed.data) })
  } catch (err) { next(err) }
})

// Каса: присутність + забрати свіжі команди. Ідентифікатор пристрою — з програми на касі.
tillCommandsRouter.post('/claim', requireRole(...TILL_ROLES), async (req, res, next) => {
  try { res.json({ data: await claimCommands(req.user!.tenant_id, String(req.body?.device_id ?? '')) }) } catch (err) { next(err) }
})

tillCommandsRouter.post('/:id/result', requireRole(...TILL_ROLES), async (req, res, next) => {
  try {
    const parsed = commandResultSchema.safeParse(req.body?.outcome)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Некоректна відповідь каси', 422)
    res.json({ data: await finishCommand(req.user!.tenant_id, String(req.body?.device_id ?? ''), String(req.params.id), parsed.data) })
  } catch (err) { next(err) }
})

tillCommandsRouter.get('/:operationId', requireRole(...WEB_COMMAND_ROLES), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await readCommand(req.user!.tenant_id, String(req.params.operationId)) })
  } catch (err) { next(err) }
})
