import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { previewOnecImport, runOnecImport } from '../services/onecImportService.js'
import { enqueueOnecImportJob, QUEUE_NAMES } from '../lib/bullmq.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('owner', 'admin', 'manager'))

// POST /api/v1/import/1c/preview — аналіз файлу без запису
router.post('/preview', async (req, res, next) => {
  try {
    const { text, mapping } = req.body
    if (!text?.trim()) throw new AppError('VALIDATION_ERROR', 'Текст файлу порожній', 422)

    const result = previewOnecImport(text, mapping)
    res.json({ data: result })
  } catch (err) { next(err) }
})

// POST /api/v1/import/1c/run — фактичний імпорт
const runSchema = z.object({
  rows:         z.array(z.any()).min(1),
  mode:         z.enum(['replace', 'add']).default('replace'),
  updatePrices: z.boolean().default(true),
})

router.post('/run', async (req, res, next) => {
  try {
    const parsed = runSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні параметри', 422, parsed.error.flatten())

    const asyncMode = req.query.async === 'true' || parsed.data.rows.length > 100

    if (asyncMode) {
      // Large imports run as background BullMQ jobs
      try {
        const jobId = await enqueueOnecImportJob({
          tenantId: req.user!.tenant_id,
          rows: parsed.data.rows,
          mode: parsed.data.mode,
          updatePrices: parsed.data.updatePrices,
        })
        return res.status(202).json({ data: { jobId, queue: QUEUE_NAMES.ONEC_IMPORT, status: 'queued' } })
      } catch {
        // Fallback to sync if Redis is unavailable
      }
    }

    const result = await runOnecImport(req.user!.tenant_id, parsed.data.rows, {
      mode:         parsed.data.mode,
      updatePrices: parsed.data.updatePrices,
    })
    res.json({ data: result })
  } catch (err) { next(err) }
})

export default router
