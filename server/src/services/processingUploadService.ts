import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

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
  await db.storage.from(PROCESSING_UPLOAD_BUCKET).remove([...new Set(owned)])
}
