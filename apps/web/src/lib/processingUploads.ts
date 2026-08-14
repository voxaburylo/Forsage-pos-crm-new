import { supabase } from './supabase'

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

  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user.id
  if (!userId) throw new Error('Сесія закінчилась. Увійдіть знову.')

  const mimeType = (blob.type || 'application/octet-stream').toLowerCase().split(';', 1)[0]
  const extension = extensionForMimeType(mimeType)
  const path = `${userId}/${purpose}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage
    .from(PROCESSING_UPLOAD_BUCKET)
    .upload(path, blob, {
      contentType: mimeType,
      cacheControl: '60',
      upsert: false,
    })
  if (error) throw new Error('Не вдалося підготувати файл: ' + error.message)
  return { path, mimeType }
}

export async function removeProcessingUploads(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const unique = [...new Set(paths)]
  await supabase.storage.from(PROCESSING_UPLOAD_BUCKET).remove(unique)
}
