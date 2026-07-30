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
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Reads one black/white value per CODE128 module from the high-resolution
 * probe. The resulting pattern is safe to embed in HTML and lets the desktop
 * printer paint the exact same bars without Chromium anti-aliasing.
 */
function readBinaryPattern(canvas: HTMLCanvasElement, modules: number, moduleScale: number): string {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || modules <= 0 || canvas.width <= 0 || canvas.height <= 0) return ''

  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height / 2)))
  const pixels = context.getImageData(0, y, canvas.width, 1).data
  let pattern = ''
  for (let moduleIndex = 0; moduleIndex < modules; moduleIndex += 1) {
    const x = Math.max(
      0,
      Math.min(canvas.width - 1, Math.floor((moduleIndex + 0.5) * moduleScale)),
    )
    const offset = x * 4
    const luma = 0.114 * pixels[offset + 2] + 0.587 * pixels[offset + 1] + 0.299 * pixels[offset]
    pattern += luma < 128 ? '1' : '0'
  }
  return pattern
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
    const pattern = readBinaryPattern(probe, modules, scale)
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

    const naturalWidthExact = Math.max(1, canvas.width / scale)
    const naturalWidth = Math.max(1, Math.round(naturalWidthExact))
    const displayWidth = displayTargetWidth ?? naturalWidth
    const displayHeight = Math.max(1, Math.round(canvas.height / scale))
    const displayedQuietZone = quietZone * (displayWidth / naturalWidthExact)
    const quietRatio = displayedQuietZone / displayWidth
    const codeAttr = isAsciiBarcode(normalized) && pattern.length === modules
      ? ` data-code="${sanitizeCodeAttr(normalized)}" data-pattern="${pattern}" data-modules="${modules}" data-quiet-zone="${displayedQuietZone}" data-quiet-ratio="${quietRatio}" data-natural-width="${naturalWidth}"`
      : ''
    return `<img class="barcode-raster"${codeAttr} src="${canvas.toDataURL('image/png')}" width="${displayWidth}" height="${displayHeight}" alt="">`
  } catch (error) {
    console.error('Failed to generate barcode image', error)
    return ''
  }
}
/**
 * Vector CODE128 for browser/driver printing. Chromium sends the bars to the
 * printer as geometry instead of resampling a screen-density PNG, so every
 * vertical edge stays straight on computers with a different DPI/driver.
 * The module pattern metadata is also consumed by the desktop TSPL renderer.
 */
export function renderBarcodePrintSvg(value: string, options: BarcodeSvgOptions = {}): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || typeof document === 'undefined') return ''

  try {
    const probeScale = 8
    const requestedHeight = Math.max(8, Number(options.height) || 28)
    const targetWidth = Math.max(1, Math.round(Number(options.targetWidth) || 120))
    const quietZonePx = Math.max(
      4,
      Math.min(18, Math.round(Number(options.quietZone) || targetWidth * 0.07)),
    )

    const probe = document.createElement('canvas')
    JsBarcode(probe, normalized, {
      format: 'CODE128',
      width: probeScale,
      height: requestedHeight * probeScale,
      margin: 0,
      displayValue: false,
      background: '#ffffff',
      lineColor: '#000000',
    })

    const modules = Math.max(1, Math.round(probe.width / probeScale))
    const pattern = readBinaryPattern(probe, modules, probeScale)
    if (pattern.length !== modules) return ''

    const barsWidthPx = Math.max(1, targetWidth - quietZonePx * 2)
    const quietUnits = modules * quietZonePx / barsWidthPx
    const viewBoxWidth = modules + quietUnits * 2
    const quietRatio = quietUnits / viewBoxWidth
    const rects: string[] = []
    let start = -1
    for (let index = 0; index <= pattern.length; index += 1) {
      if (pattern[index] === '1' && start < 0) start = index
      if (pattern[index] !== '1' && start >= 0) {
        rects.push(`<rect x="${quietUnits + start}" y="0" width="${index - start}" height="${requestedHeight}"/>`)
        start = -1
      }
    }

    const codeAttr = isAsciiBarcode(normalized)
      ? ` data-code="${sanitizeCodeAttr(normalized)}" data-pattern="${pattern}" data-modules="${modules}" data-quiet-zone="${quietZonePx}" data-quiet-ratio="${quietRatio}" data-natural-width="${targetWidth}"`
      : ''
    return `<svg class="barcode-vector"${codeAttr} width="${targetWidth}" height="${requestedHeight}" viewBox="0 0 ${viewBoxWidth} ${requestedHeight}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Штрихкод ${sanitizeCodeAttr(normalized)}" shape-rendering="crispEdges"><rect width="${viewBoxWidth}" height="${requestedHeight}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`
  } catch (error) {
    console.error('Failed to generate vector barcode', error)
    return ''
  }
}
