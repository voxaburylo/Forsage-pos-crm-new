import { prepareImageDataUrl } from '@/lib/prepareImage'

export async function fileToCompressedImage(file: File): Promise<{ name: string; dataUrl: string }> {
  return { name: file.name, dataUrl: await prepareImageDataUrl(file) }
}
