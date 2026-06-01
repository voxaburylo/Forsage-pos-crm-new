import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { parseImportSchema, confirmImportSchema, previewImportSchema } from '../validators/importSchema.js'
import { parseClipboardText, confirmImport, previewImport } from '../services/importService.js'

export async function parse(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = parseImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await parseClipboardText(parsed.data)
    res.json(result)
  } catch (err) { next(err) }
}

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = previewImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await previewImport(parsed.data)
    res.json(result)
  } catch (err) { next(err) }
}

export async function confirm(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = confirmImportSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірні дані', 422, parsed.error.flatten())
    const result = await confirmImport(parsed.data, req.user!.id)
    res.status(201).json({ data: result })
  } catch (err) { next(err) }
}
