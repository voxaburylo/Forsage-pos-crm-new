import { CAMERA_FORMATS } from './cameraScan'

/**
 * Розпізнавач штрихкоду в кадрі камери. Готується один раз (при появі екрана зі сканером), щоб натискання «курка»
 * одразу читало, а не чекало на завантаження.
 * Вбудований розпізнавач телефона (BarcodeDetector, Android) — якщо є; інакше (iPhone) — zxing у WebAssembly.
 */
export type Found = Array<{ rawValue: string }>
export type FrameReader = (video: HTMLVideoElement) => Promise<Found>
type NativeDetector = { detect(source: CanvasImageSource): Promise<Found> }
type DetectorCtor = { new(options: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> }

export interface FrameRegion { sx: number; sy: number; sw: number; sh: number; width: number; height: number }
/**
 * Яку частину кадру розбирати. Картинки камери на екрані немає, тож код може бути будь-де в кадрі.
 * По черзі: середина кадру (80% × 50%) і весь кадр — обидва БЕЗ зменшення. Проба 26.11.2026 на кадрі 1920×1080:
 * стара схема (смуга посередині, зменшена до 960 точок) читала лише великий код точно по центру (1 з 6 випадків),
 * кадр, зменшений до 1280, не читав середній код біля краю; без зменшення — 6 з 6.
 */
export function frameRegion(width: number, height: number, turn: number): FrameRegion {
  if (turn % 2) {
    const sw = Math.round(width * 0.8), sh = Math.round(height * 0.5)
    return { sx: Math.round((width - sw) / 2), sy: Math.round((height - sh) / 2), sw, sh, width: sw, height: sh }
  }
  const scale = Math.min(1, 1920 / Math.max(width, height))
  return { sx: 0, sy: 0, sw: width, sh: height, width: Math.round(width * scale), height: Math.round(height * scale) }
}

async function nativeReader(): Promise<FrameReader | null> {
  const Detector = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
  if (!Detector) return null
  const supported = await Detector.getSupportedFormats?.().catch(() => null)
  const formats = supported ? CAMERA_FORMATS.filter(format => supported.includes(format)) : [...CAMERA_FORMATS]
  if (!formats.length) return null
  const detector = new Detector({ formats })
  return video => detector.detect(video)
}

async function zxingReader(): Promise<FrameReader> {
  const detector = await import('./zxingDetector').then(module => module.createZxingDetector(CAMERA_FORMATS))
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('canvas')
  let turn = 0
  return video => {
    const width = video.videoWidth, height = video.videoHeight
    if (!width || !height) return Promise.resolve([])
    turn += 1
    const region = frameRegion(width, height, turn)
    canvas.width = region.width; canvas.height = region.height
    context.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, region.width, region.height)
    return detector.detect(canvas)
  }
}

let reader: Promise<FrameReader> | null = null
export function cameraFrameReader(): Promise<FrameReader> {
  reader ??= (async () => (await nativeReader().catch(() => null)) ?? await zxingReader())()
  // Не вдалося (наприклад, без інтернету не завантажився zxing) — наступного разу пробуємо знову.
  reader.catch(() => { reader = null })
  return reader
}
/** Підготувати розпізнавач заздалегідь; помилка тут нікому не заважає. */
export function warmCameraReader(): void { void cameraFrameReader().catch(() => undefined) }
