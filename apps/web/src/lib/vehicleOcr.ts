import { api } from '@/lib/api'
import { removeProcessingUploads, uploadProcessingBlob } from '@/lib/processingUploads'

export interface VehicleOcrData {
  document_type: 'vin' | 'registration_certificate' | 'other'
  vin: string | null
  make: string | null
  model: string | null
  year: number | null
  registration_number: string | null
}

async function compressVehicleImage(file: Blob): Promise<Blob> {
  const image = new Image()
  const objectUrl = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Не вдалося прочитати фото'))
      image.src = objectUrl
    })
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не вдалося підготувати фото')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не вдалося підготувати фото')), 'image/jpeg', 0.82)
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function recognizeVehicleImage(file: Blob): Promise<VehicleOcrData> {
  if (!file.type.startsWith('image/')) throw new Error('Оберіть фото у форматі JPG, PNG або WEBP')
  const compressed = await compressVehicleImage(file)
  const uploaded = await uploadProcessingBlob(compressed, 'vin')
  try {
    const response = await api.post<{ data: VehicleOcrData }>('/api/v1/vin/ocr', {
      storage_path: uploaded.path,
    }, undefined, { timeoutMs: 180_000, silent: true })
    return response.data
  } finally {
    await removeProcessingUploads([uploaded.path]).catch(() => {})
  }
}
