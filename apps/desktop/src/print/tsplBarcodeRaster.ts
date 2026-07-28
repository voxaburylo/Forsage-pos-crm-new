export interface BarcodeCanvasGeometryInput {
  pattern: string
  /** Barcode image size in CSS pixels from getBoundingClientRect(). */
  rectWidth: number
  rectHeight: number
  /** White margin on one side divided by the full image width. */
  quietRatio: number
  /** Physical printer dots per CSS pixel for the current label page. */
  scaleX: number
  scaleY: number
}

export interface BarcodeCanvasGeometry {
  ok: true
  widthDots: number
  heightDots: number
  quietZoneDots: number
  barsWidthDots: number
  requiredWidthDots: number
}

export interface InvalidBarcodeCanvasGeometry {
  ok: false
  reason: 'invalid-pattern' | 'invalid-size' | 'too-narrow'
  widthDots: number
  heightDots: number
  barsWidthDots: number
  requiredWidthDots: number
}

export type BarcodeCanvasGeometryResult = BarcodeCanvasGeometry | InvalidBarcodeCanvasGeometry

function finite(value: unknown, fallback: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function invalid(
  reason: InvalidBarcodeCanvasGeometry['reason'],
  widthDots = 0,
  heightDots = 0,
  barsWidthDots = 0,
  requiredWidthDots = 0,
): InvalidBarcodeCanvasGeometry {
  return { ok: false, reason, widthDots, heightDots, barsWidthDots, requiredWidthDots }
}

/**
 * Converts the designer rectangle to a canvas whose backing pixels are exactly
 * printer dots. One CODE128 module must receive at least one physical dot;
 * otherwise the code is rejected instead of silently merging bars and gaps.
 */
export function calculateBarcodeCanvasGeometry(
  input: BarcodeCanvasGeometryInput,
): BarcodeCanvasGeometryResult {
  const pattern = String(input.pattern ?? '')
  if (!/^[01]+$/.test(pattern)) return invalid('invalid-pattern')

  const rectWidth = finite(input.rectWidth, 0)
  const rectHeight = finite(input.rectHeight, 0)
  const scaleX = finite(input.scaleX, 0)
  const scaleY = finite(input.scaleY, 0)
  if (rectWidth <= 0 || rectHeight <= 0 || scaleX <= 0 || scaleY <= 0) {
    return invalid('invalid-size')
  }

  const widthDots = Math.max(1, Math.round(rectWidth * scaleX))
  const heightDots = Math.max(1, Math.round(rectHeight * scaleY))
  const quietRatio = Math.max(0, Math.min(0.49, finite(input.quietRatio, 0)))
  const printableRatio = 1 - quietRatio * 2
  const quietZoneDots = widthDots * quietRatio
  const barsWidthDots = widthDots * printableRatio
  const requiredWidthDots = Math.ceil(pattern.length / printableRatio)

  if (barsWidthDots + Number.EPSILON < pattern.length) {
    return invalid('too-narrow', widthDots, heightDots, barsWidthDots, requiredWidthDots)
  }

  return {
    ok: true,
    widthDots,
    heightDots,
    quietZoneDots,
    barsWidthDots,
    requiredWidthDots,
  }
}
