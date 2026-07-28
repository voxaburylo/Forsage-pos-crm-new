import { describe, expect, it } from 'vitest'
import { calculateBarcodeCanvasGeometry } from '../src/print/tsplBarcodeRaster'

describe('TSPL barcode canvas geometry', () => {
  it('keeps the designer quiet-zone ratio in physical printer dots', () => {
    const geometry = calculateBarcodeCanvasGeometry({
      pattern: '10'.repeat(61) + '1',
      rectWidth: 123,
      rectHeight: 24,
      quietRatio: 17 / 246,
      scaleX: 2,
      scaleY: 2,
    })

    expect(geometry.ok).toBe(true)
    if (!geometry.ok) return
    expect(geometry.widthDots).toBe(246)
    expect(geometry.heightDots).toBe(48)
    expect(geometry.quietZoneDots).toBeCloseTo(17)
    expect(geometry.barsWidthDots).toBeCloseTo(212)
  })

  it('accepts the exact safe limit of one physical dot per module', () => {
    const geometry = calculateBarcodeCanvasGeometry({
      pattern: '10101010',
      rectWidth: 10,
      rectHeight: 8,
      quietRatio: 0.1,
      scaleX: 1,
      scaleY: 1,
    })

    expect(geometry).toMatchObject({
      ok: true,
      widthDots: 10,
      barsWidthDots: 8,
      requiredWidthDots: 10,
    })
  })

  it('rejects a barcode that would merge modules at printer resolution', () => {
    const geometry = calculateBarcodeCanvasGeometry({
      pattern: '10101010',
      rectWidth: 9,
      rectHeight: 8,
      quietRatio: 0.1,
      scaleX: 1,
      scaleY: 1,
    })

    expect(geometry).toMatchObject({
      ok: false,
      reason: 'too-narrow',
      widthDots: 9,
      requiredWidthDots: 10,
    })
  })

  it('rejects zero-sized DOM rectangles instead of silently using raster fallback', () => {
    expect(calculateBarcodeCanvasGeometry({
      pattern: '10101',
      rectWidth: 0,
      rectHeight: 20,
      quietRatio: 0.05,
      scaleX: 2,
      scaleY: 2,
    })).toMatchObject({ ok: false, reason: 'invalid-size' })
  })
  it('rejects malformed binary patterns without preparing a canvas', () => {
    expect(calculateBarcodeCanvasGeometry({
      pattern: '10x1',
      rectWidth: 100,
      rectHeight: 20,
      quietRatio: 0.05,
      scaleX: 2,
      scaleY: 2,
    })).toMatchObject({ ok: false, reason: 'invalid-pattern' })
  })
})
