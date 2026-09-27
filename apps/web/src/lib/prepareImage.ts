const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_DECODE_TIMEOUT_MS = 15_000

/** Shared preparation for invoice photos and VIN: bounded decode, white JPEG, no enlargement. */
export async function prepareImageDataUrl(
  file: Blob,
  options: { maxDimension?: number; quality?: number } = {},
): Promise<string> {
  if (!file.size) throw new Error('Фото порожнє — виберіть інший файл')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Фото завелике — максимум 20 МБ')
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        el.onload = null
        el.onerror = null
        if (error) { el.src = ''; reject(error) } else resolve(el)
      }
      const timer = setTimeout(() => finish(new Error('Не вдалося підготувати фото за 15 секунд. Спробуйте інший JPG або PNG.')), IMAGE_DECODE_TIMEOUT_MS)
      el.onload = () => finish()
      el.onerror = () => finish(new Error('Не вдалося прочитати фото (спробуйте JPG або PNG)'))
      el.src = objectUrl
    })
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Фото не має коректного розміру')
    const scale = Math.min(1, (options.maxDimension ?? 1800) / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Не вдалося підготувати зображення')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/jpeg', options.quality ?? 0.88)
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length < 30) throw new Error('Не вдалося підготувати зображення')
    return dataUrl
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
