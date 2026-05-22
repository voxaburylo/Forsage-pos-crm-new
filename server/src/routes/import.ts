import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { parseImportSchema, confirmImportSchema, previewImportSchema } from '../validators/importSchema.js'
import { parseClipboardText, confirmImport, previewImport } from '../services/importService.js'

const router = Router()
router.use(requireAuth)

const ALLOWED = ['owner', 'admin', 'manager', 'storekeeper'] as const

router.post('/parse', requireRole(...ALLOWED), async (req, res, next) => {
  try {
    const parsed = parseImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await parseClipboardText(parsed.data)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/preview', requireRole(...ALLOWED), async (req, res, next) => {
  try {
    const parsed = previewImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await previewImport(parsed.data)
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/confirm', requireRole(...ALLOWED), async (req, res, next) => {
  try {
    const parsed = confirmImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await confirmImport(parsed.data, req.user!.id)
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
})

export default router

