/**
 * 24.11.2026 (план C2, етап 2 плану замовлень): мініатюра товару вирізається зі скриншота кошика по рядку.
 * ШІ називає, де в рядку картинка товару ([ліво, верх, ширина, висота] у відсотках від усього скриншота).
 * Межі, яким не можна вірити (за краєм, крихітні, на пів екрана), відкидаються — тоді мініатюри просто немає.
 */
export type ImageBox = [number, number, number, number]

export function readImageBox(raw: unknown): ImageBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const [left, top, width, height] = raw.map(Number)
  if (![left, top, width, height].every(Number.isFinite)) return null
  if (left < 0 || top < 0 || width < 1 || height < 1 || width > 40 || height > 40) return null
  if (left + width > 100.5 || top + height > 100.5) return null
  return [left, top, width, height]
}

export const THUMB_SIZE = 96

/** Вирізати мініатюру з уже завантаженого скриншота. Повертає JPEG як data URL або null, якщо не вийшло. */
export function cropThumbnail(image: CanvasImageSource & { width: number; height: number }, box: ImageBox, make: () => HTMLCanvasElement = () => document.createElement('canvas')): string | null {
  const [left, top, width, height] = box
  const sx = image.width * left / 100, sy = image.height * top / 100
  const sw = Math.max(1, image.width * width / 100), sh = Math.max(1, image.height * height / 100)
  const scale = THUMB_SIZE / Math.max(sw, sh)
  const canvas = make()
  canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', 0.82)
  return /^data:image\/jpeg;base64,/.test(url) && url.length <= 80_000 ? url : null
}

export async function loadImage(blob: Blob): Promise<(CanvasImageSource & { width: number; height: number }) | null> {
  try { return await createImageBitmap(blob) } catch { return null }
}
