import JsBarcode from 'jsbarcode'

export interface BarcodeSvgOptions {
  /** Базова ширина найтоншої риски у CSS px. */
  width?: number
  height?: number
  /** Фактична ширина області штрихкоду у CSS px. Якщо задана — код генерується одразу під неї, без CSS-стиснення. */
  targetWidth?: number
  /** Біле поле зліва/справа у CSS px. Сканеру потрібна «тиха зона», інакше крайні риски читаються погано. */
  quietZone?: number
}

function isAsciiBarcode(value: string): boolean {
  return /[\x20-\x7e]+/.test(value) && !/[^\x20-\x7e]/.test(value)
}

function sanitizeCodeAttr(value: string): string {
  return value.replace(/"/g, '')
}

/**
 * Creates a high-resolution raster barcode synchronously before print.
 *
 * Important: when targetWidth is passed, the barcode is rendered at that exact
 * visual width. We avoid CSS downscaling/upscaling because it changes apparent
 * bar/gap thickness on thermal printers and makes scanners miss narrow gaps.
 */
export function renderBarcodeSvg(value: string, options: BarcodeSvgOptions = {}): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || typeof document === 'undefined') return ''

  try {
    const scale = 8
    const requestedHeight = Math.max(8, Number(options.height) || 28)
    const baseModuleWidth = Math.max(0.4, Number(options.width) || 1.2)
    const targetWidth = Number(options.targetWidth)
    const hasTargetWidth = Number.isFinite(targetWidth) && targetWidth > 0

    const probe = document.createElement('canvas')
    JsBarcode(probe, normalized, {
      format: 'CODE128',
      width: scale,
      height: requestedHeight * scale,
      margin: 0,
      displayValue: false,
      background: '#ffffff',
      lineColor: '#000000',
    })

    const modules = Math.max(1, Math.round(probe.width / scale))
    const displayTargetWidth = hasTargetWidth ? Math.max(1, Math.round(targetWidth)) : null
    const quietZone = displayTargetWidth
      ? Math.max(4, Math.min(18, Math.round(Number(options.quietZone) || displayTargetWidth * 0.07)))
      : Math.max(4, Math.round(Number(options.quietZone) || 8))
    const availableForBars = displayTargetWidth ? Math.max(1, displayTargetWidth - quietZone * 2) : null
    const moduleWidth = availableForBars
      ? Math.max(0.35, availableForBars / modules)
      : baseModuleWidth

    const canvas = document.createElement('canvas')
    JsBarcode(canvas, normalized, {
      format: 'CODE128',
      width: moduleWidth * scale,
      height: requestedHeight * scale,
      margin: 0,
      marginLeft: quietZone * scale,
      marginRight: quietZone * scale,
      marginTop: 0,
      marginBottom: 0,
      displayValue: false,
      background: '#ffffff',
      lineColor: '#000000',
    })

    const naturalWidth = Math.max(1, Math.round(canvas.width / scale))
    const displayWidth = displayTargetWidth ?? naturalWidth
    const displayHeight = Math.max(1, Math.round(canvas.height / scale))
    const codeAttr = isAsciiBarcode(normalized)
      ? ` data-code="${sanitizeCodeAttr(normalized)}" data-modules="${modules}" data-quiet-zone="${quietZone}" data-natural-width="${naturalWidth}"`
      : ''
    return `<img class="barcode-raster"${codeAttr} src="${canvas.toDataURL('image/png')}" width="${displayWidth}" height="${displayHeight}" alt="">`
  } catch (error) {
    console.error('Failed to generate barcode image', error)
    return ''
  }
}
