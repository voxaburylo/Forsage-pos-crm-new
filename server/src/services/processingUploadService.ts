import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { logger } from '../lib/logger.js'
import { safeErrorInfo } from '../lib/safeErrorInfo.js'
import { withAiExecutionBudget } from './aiExecutionBudget.js'

export const PROCESSING_UPLOAD_BUCKET = 'processing-uploads'

const PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ai|vin|supplier-import)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i

function validateOwnedPath(path: string, userId: string, purpose?: 'ai' | 'vin' | 'supplier-import'): void {
  if (!PATH_PATTERN.test(path)) {
    throw new AppError('INVALID_UPLOAD_PATH', 'Невірний шлях тимчасового файлу', 422)
  }
  const [ownerId, actualPurpose] = path.split('/')
  if (ownerId !== userId || (purpose && actualPurpose !== purpose)) {
    throw new AppError('UPLOAD_ACCESS_DENIED', 'Немає доступу до цього тимчасового файлу', 403)
  }
}

export async function downloadProcessingUpload(options: {
  path: string
  userId: string
  purpose?: 'ai' | 'vin' | 'supplier-import'
  maxBytes: number
  allowedMimeTypes: readonly string[]
}): Promise<{ buffer: Buffer; mimeType: string }> {
  validateOwnedPath(options.path, options.userId, options.purpose)

  const { data, error } = await db.storage
    .from(PROCESSING_UPLOAD_BUCKET)
    .download(options.path)

  if (error || !data) {
    throw new AppError('UPLOAD_NOT_FOUND', 'Тимчасовий файл не знайдено або він уже оброблений', 404)
  }
  if (data.size > options.maxBytes) {
    throw new AppError('UPLOAD_TOO_LARGE', 'Файл завеликий для обробки', 413)
  }

  const mimeType = String(data.type || 'application/octet-stream').toLowerCase()
  if (!options.allowedMimeTypes.includes(mimeType)) {
    throw new AppError('UPLOAD_TYPE_NOT_ALLOWED', 'Цей тип файлу не підтримується', 422)
  }

  return {
    buffer: Buffer.from(await data.arrayBuffer()),
    mimeType,
  }
}

export async function removeProcessingUploads(paths: readonly string[], userId: string): Promise<void> {
  const owned = paths.filter((path) => {
    try {
      validateOwnedPath(path, userId)
      return true
    } catch {
      return false
    }
  })
  if (owned.length === 0) return

  // Service role bypasses Storage RLS; ownership is checked above before delete.
  // Cleanup must not hold a completed recognition request open indefinitely.
  try {
    await withAiExecutionBudget(5_000, async budget => {
      const { error } = await budget.run(() => db.storage.from(PROCESSING_UPLOAD_BUCKET).remove([...new Set(owned)]))
      if (error) throw error
    })
  } catch (error) {
    logger.warn({ code: 'AI_PROCESSING_CLEANUP_FAILED', ...safeErrorInfo(error) }, 'Temporary upload cleanup failed')
    throw new AppError('AI_PROCESSING_CLEANUP_FAILED', 'Не вдалося підтвердити очищення тимчасових вкладень.', 502)
  }
}

const STORED_UPLOAD_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }
export const STORED_UPLOAD_MAX_BYTES = 12 * 1024 * 1024

/**
 * 24.11.2026: вкладення помічника від головного ПК власним ключем. У працівника, який увійшов на касі локальним
 * паролем чи PIN, немає сесії сховища — файл кладе сервер у ту саму теку тимчасових файлів, з тими самими правилами
 * шляху (власник шляху — користувач, від імені якого діє ключ ПК). Після розбору файл видаляється, як завжди.
 */
export async function storeProcessingUpload(options: { userId: string; purpose: 'ai' | 'vin'; mimeType: string; buffer: Buffer }): Promise<{ path: string; mimeType: string }> {
  const extension = STORED_UPLOAD_TYPES[options.mimeType]
  if (!extension) throw new AppError('UPLOAD_TYPE_NOT_ALLOWED', 'Цей тип файлу не підтримується', 422)
  if (options.buffer.length === 0) throw new AppError('VALIDATION_ERROR', 'Файл порожній', 422)
  if (options.buffer.length > STORED_UPLOAD_MAX_BYTES) throw new AppError('UPLOAD_TOO_LARGE', 'Файл завеликий для обробки', 413)
  const path = options.userId + '/' + options.purpose + '/' + crypto.randomUUID() + '.' + extension
  validateOwnedPath(path, options.userId, options.purpose)
  const { error } = await db.storage.from(PROCESSING_UPLOAD_BUCKET).upload(path, options.buffer, { contentType: options.mimeType, cacheControl: '60', upsert: false })
  if (error) throw new AppError('UPLOAD_FAILED', 'Не вдалося підготувати файл. Повторіть.', 502)
  return { path, mimeType: options.mimeType }
}
