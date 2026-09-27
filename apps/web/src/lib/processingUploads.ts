import { supabase } from './supabase'
import { reportLocalError } from './localDiagnostics'

class ProcessingTimeoutError extends Error {
  readonly code = 'PROCESSING_TIMEOUT'
}

// The installed Storage SDK cannot abort upload/remove. Bound the caller's wait;
// an abandoned upload is removed again if its response arrives late.
function withDeadline<T>(operation: Promise<T>, ms: number, message: string, onLate?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => { expired = true; reject(new ProcessingTimeoutError(message)) }, ms)
    operation.then(value => {
      clearTimeout(timer)
      if (expired) { onLate?.(); return }
      resolve(value)
    }, error => {
      clearTimeout(timer)
      if (expired) { onLate?.(); return }
      reject(error)
    })
  })
}

function cleanupAbandonedUpload(path: string): void {
  void removeProcessingUploads([path]).catch(() => { /* recorded by cleanup */ })
}

const PROCESSING_UPLOAD_BUCKET = 'processing-uploads'
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export type ProcessingUploadPurpose = 'ai' | 'vin' | 'supplier-import'

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'text/csv':
    case 'application/csv': return 'csv'
    default: return 'jpg'
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload] = dataUrl.split(',', 2)
  const mimeType = header.match(/^data:([^;]+);base64$/i)?.[1] ?? 'application/octet-stream'
  if (!payload) throw new Error('Пошкоджене зображення')
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

export async function uploadProcessingBlob(
  blob: Blob,
  purpose: ProcessingUploadPurpose,
): Promise<{ path: string; mimeType: string }> {
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Файл завеликий — максимум 25 МБ')

  if (blob.size === 0) throw new Error('Файл порожній')
  const { data: sessionData, error: sessionError } = await withDeadline(
    supabase.auth.getSession(), 15_000,
    'Перевірка сесії триває надто довго. Перевірте інтернет і повторіть.',
  )
  if (sessionError) throw new Error('Не вдалося перевірити сесію. Увійдіть знову.')
  const userId = sessionData.session?.user.id
  if (!userId) throw new Error('Сесія закінчилась. Увійдіть знову.')

  const mimeType = (blob.type || 'application/octet-stream').toLowerCase().split(';', 1)[0]
  const extension = extensionForMimeType(mimeType)
  const path = `${userId}/${purpose}/${crypto.randomUUID()}.${extension}`
  try {
    const { error } = await withDeadline(supabase.storage
      .from(PROCESSING_UPLOAD_BUCKET)
      .upload(path, blob, {
        contentType: mimeType,
        cacheControl: '60',
        upsert: false,
      }), 60_000, 'Завантаження файла триває надто довго. Перевірте інтернет і повторіть.',
      () => cleanupAbandonedUpload(path))
    if (error) throw new Error('Не вдалося підготувати файл. Перевірте інтернет і повторіть.')
  } catch (error) {
    // A lost response does not prove that storage did not accept the object.
    cleanupAbandonedUpload(path)
    if (error instanceof ProcessingTimeoutError) throw error
    throw new Error('Не вдалося підготувати файл. Перевірте інтернет і повторіть.')
  }
  return { path, mimeType }
}

export async function removeProcessingUploads(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const unique = [...new Set(paths)]
  try {
    const { error } = await withDeadline(
      supabase.storage.from(PROCESSING_UPLOAD_BUCKET).remove(unique), 5_000,
      'Очищення тимчасових файлів перевищило час очікування.',
    )
    if (error) throw new Error('Не вдалося очистити тимчасові файли.')
  } catch {
    // Do not forward storage paths, tokens or the original server exception.
    reportLocalError(new Error('AI_PROCESSING_CLEANUP_FAILED'))
    throw new Error('Не вдалося очистити тимчасові файли.')
  }
}
