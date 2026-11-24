import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { cropThumbnail, readImageBox, THUMB_SIZE } from './cartThumbnails'

// 24.11.2026 (план C2): мініатюра товару зі скриншота кошика — лише з правдоподібних меж.
describe('thumbnails from the cart screenshot', () => {
  it('accepts a plausible box and refuses boxes outside the picture, tiny, huge or malformed', () => {
    expect(readImageBox([2, 10, 6, 5])).toEqual([2, 10, 6, 5])
    for (const raw of [null, [1, 2, 3], ['a', 1, 2, 3], [-1, 0, 5, 5], [98, 0, 5, 5], [0, 0, 0.5, 5], [0, 0, 60, 5], [0, 97, 5, 5]]) {
      expect(readImageBox(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('cuts the box at the screenshot scale into a small JPEG', () => {
    const drawImage = vi.fn()
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage }), toDataURL: () => 'data:image/jpeg;base64,AAAA' }
    const url = cropThumbnail({ width: 1000, height: 2000 } as never, [10, 5, 6, 3], () => canvas as never)
    expect(url).toBe('data:image/jpeg;base64,AAAA')
    // 6% × 1000 = 60 px, 3% × 2000 = 60 px → квадрат, зведений до 96 px.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 100, 60, 60, 0, 0, THUMB_SIZE, THUMB_SIZE)
    expect(cropThumbnail({ width: 10, height: 10 } as never, [0, 0, 10, 10], () => ({ ...canvas, getContext: () => null }) as never)).toBeNull()
    expect(cropThumbnail({ width: 10, height: 10 } as never, [0, 0, 10, 10], () => ({ ...canvas, toDataURL: () => 'data:image/png;base64,AA' }) as never)).toBeNull()
  })

  it('asks the assistant for the box only for cart screenshots, and the invoice schema marks it optional for invoices', () => {
    const cart = readFileSync(new URL('./orderCartScreenshot.ts', import.meta.url), 'utf8')
    expect(cart).toContain('у image_box вкажи її межі')
    const server = readFileSync(new URL('../../../../../server/src/services/aiService.ts', import.meta.url), 'utf8')
    expect(server).toContain("image_box: { type: SchemaType.ARRAY, items: { type: SchemaType.NUMBER }, description: 'Лише коли запит просить мініатюри (скриншот кошика)")
  })
})
