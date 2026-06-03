import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { parseImportSchema, confirmImportSchema, previewImportSchema } from '../validators/importSchema.js'
import { parseClipboardText, confirmImport, previewImport } from '../services/importService.js'
import { enqueueImportJob, QUEUE_NAMES } from '../lib/bullmq.js'

export async function parse(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = parseImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await parseClipboardText(parsed.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
}

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = previewImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await previewImport(parsed.data, req.user!.tenant_id)
    res.json(result)
  } catch (err) { next(err) }
}

export async function confirm(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = confirmImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())

    const asyncMode = req.query.async === 'true' || parsed.data.items.length > 100

    if (asyncMode) {
      try {
        const jobId = await enqueueImportJob({
          items: parsed.data.items,
          userId: req.user!.id,
          supplierId: parsed.data.supplier_id || undefined,
          mode: parsed.data.mode || 'replace',
          createMissing: parsed.data.create_missing ?? false,
          updateRetail: parsed.data.update_retail ?? true,
          tenantId: req.user!.tenant_id,
        })
        return res.status(202).json({
          data: {
            jobId,
            queue: QUEUE_NAMES.IMPORT,
            status: 'queued',
          },
        })
      } catch (err: any) {
        // Fallback to synchronous import if queue fails (e.g. Redis connection issue)
      }
    }

    const result = await confirmImport(parsed.data, req.user!.id, req.user!.tenant_id)
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
}