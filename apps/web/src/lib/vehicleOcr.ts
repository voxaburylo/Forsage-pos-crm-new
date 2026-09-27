import { api } from '@/lib/api'
import { dataUrlToBlob, removeProcessingUploads, uploadProcessingBlob } from '@/lib/processingUploads'
import { prepareImageDataUrl } from '@/lib/prepareImage'

export interface VehicleOcrData {
  document_type: 'vin' | 'registration_certificate' | 'other'
  vin: string | null
  make: string | null
  model: string | null
  year: number | null
  registration_number: string | null
}

async function compressVehicleImage(file: Blob): Promise<Blob> {
  return dataUrlToBlob(await prepareImageDataUrl(file, { maxDimension: 1600, quality: 0.82 }))
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
