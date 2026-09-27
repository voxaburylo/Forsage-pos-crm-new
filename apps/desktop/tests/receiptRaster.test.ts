import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), nativeImage: {} }))
import { receiptRasterLayout, monochromeReceipt, receiptFrameHasInk, receiptFrameHasFence } from '../src/print/receiptRaster'

describe('receipt printer pixel layout', () => {
  it('ignores blank resize frames and waits for actual receipt ink', () => {
    const frame = (pixels: number[]) => ({ toBitmap: () => Buffer.from(pixels) }) as unknown as Electron.NativeImage
    expect(receiptFrameHasInk(frame([255,255,255,255]))).toBe(false)
    expect(receiptFrameHasInk(frame([0,0,0,0]))).toBe(false)
    expect(receiptFrameHasInk(frame([255,255,255,255,0,0,0,255]))).toBe(true)
  })
  it('rejects an enlarged partial paint frame even when the old top has ink', () => {
    const pixels = Buffer.alloc(6 * 10 * 4, 255)
    pixels.fill(0, 0, 3)
    const frame = { getSize: () => ({width:6,height:10}), toBitmap: () => pixels } as unknown as Electron.NativeImage
    expect(receiptFrameHasInk(frame,4,8)).toBe(true)
    expect(receiptFrameHasFence(frame,4,8)).toBe(false)
    const offset = (8 * 6 + 4) * 4
    pixels.fill(0, offset, offset + 3)
    expect(receiptFrameHasFence(frame,4,8)).toBe(true)
    pixels[offset+3] = 0
    expect(receiptFrameHasFence(frame,4,8)).toBe(false)
    expect(receiptFrameHasFence(frame,6,10)).toBe(false)
  })
  it('does not confuse the unprinted fence with actual receipt content', () => {
    const pixels = Buffer.alloc(6 * 10 * 4, 255), offset = (8 * 6 + 4) * 4
    pixels.fill(0, offset, offset + 3)
    const frame = { getSize: () => ({width:6,height:10}), toBitmap: () => pixels } as unknown as Electron.NativeImage
    expect(receiptFrameHasFence(frame,4,8)).toBe(true)
    expect(receiptFrameHasInk(frame,4,8)).toBe(false)
  })
  it('reflows a 384-dot head at 203 dpi without squeezing the page', () => {
    const layout = receiptRasterLayout({ widthDots: 384, dpiX: 203, dpiY: 203 })
    expect(layout.cssWidth * layout.zoom).toBeCloseTo(384)
    expect(layout.cssWidth * 25.4 / 96).toBeCloseTo(48.047, 2)
    expect(layout.zoom).toBeCloseTo(203 / 96)
  })
  it('rejects invalid or incompatible printer profiles before printing', () => {
    for (const profile of [{widthDots:NaN,dpiX:203,dpiY:203},{widthDots:0,dpiX:203,dpiY:203},{widthDots:384,dpiX:203,dpiY:300},{widthDots:384,dpiX:-4,dpiY:-4},{widthDots:800,dpiX:203,dpiY:203}]) expect(() => receiptRasterLayout(profile)).toThrow()
  })
  it('removes grey dithering, preserves opaque black and composites transparency on white', async () => {
    const input = Buffer.from([0,0,0,255, 150,150,150,255, 200,200,200,255, 0,0,0,0])
    expect([...await monochromeReceipt(input,4,1,4,1)]).toEqual([0,0,0,255, 0,0,0,255, 255,255,255,255, 255,255,255,255])
  })
  it('crops only viewport safety pixels and does not merge neighbouring dots', async () => {
    const input = Buffer.from([0,0,0,255, 255,255,255,255, 0,0,0,255, 255,255,255,255, 0,0,0,255, 255,255,255,255])
    expect([...await monochromeReceipt(input,3,2,2,2)]).toEqual([0,0,0,255, 255,255,255,255, 255,255,255,255, 0,0,0,255])
  })
  it('rejects truncated frames rather than printing partial receipts', async () => {
    await expect(monochromeReceipt(Buffer.alloc(4),2,2,2,2)).rejects.toThrow('PRINT_RECEIPT_SIZE_INVALID')
  })
})
