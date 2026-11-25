import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isRecognizableText, placeRecognizedRow, readClipboard, skuKey, textPages } from './orderClipboard'

// 25.11.2026 (власник): «кнопка «вставить из буфера» і Ctrl+V прямо в открытом окне заказа — фото або текст
// розпізнаються й раскладываются по местам: имена, артикулы, цены, количество, склад/поставщик».
describe('order paste from the clipboard', () => {
  const row = { name: 'Фільтр оливи', sku: 'oc-90', qty: '2', buy_price: '150' }
  const product = { id: 'p1', name: 'Фільтр оливи KNECHT OC90', sku: 'OC 90', retail_price: 32000, purchase_price: 21000, qty_on_hand: 5 }

  it('matches the article regardless of spaces, dashes and letter case', () => {
    expect(skuKey('oc-90')).toBe(skuKey('OC 90'))
    expect(skuKey(' 1.987.302.035 ')).toBe('1987302035')
  })

  it('in stock: the row becomes «склад» with the card, its sale price and purchase price', () => {
    expect(placeRecognizedRow(row, [product])).toMatchObject({ product_id: 'p1', name: 'Фільтр оливи KNECHT OC90', sku: 'OC 90', source_type: 'warehouse', sell_price: '320.00', buy_price: '210.00', stock: 5, qty: '2' })
  })

  it('known but not enough stock: linked to the card, but ordered from the supplier at the cart price', () => {
    expect(placeRecognizedRow(row, [{ ...product, qty_on_hand: 1 }])).toMatchObject({ product_id: 'p1', source_type: 'supplier', buy_price: '150', sell_price: '320.00' })
  })

  it('unknown article or a partial match: stays as recognized, from the supplier', () => {
    expect(placeRecognizedRow(row, [{ ...product, sku: 'OC 905' }])).toEqual({ ...row, source_type: 'supplier' })
    expect(placeRecognizedRow({ ...row, sku: '' }, [product])).toEqual({ ...row, sku: '', source_type: 'supplier' })
  })

  it('recognizes text with letters only; an empty paste or a bare number is ignored', () => {
    expect(isRecognizableText('Фільтр OC90 2 шт 150 грн')).toBe(true)
    expect(isRecognizableText('  ')).toBe(false)
    expect(isRecognizableText('12345')).toBe(false)
  })

  it('splits long text into readable pages and wraps very long lines', () => {
    const pages = textPages(Array.from({ length: 130 }, (_, i) => `Рядок ${i}`).join('\n'))
    expect(pages.map(page => page.length)).toEqual([60, 60, 10])
    expect(textPages('x'.repeat(250), 110)[0]).toEqual(['x'.repeat(110), 'x'.repeat(110), 'x'.repeat(30)])
  })

  it('the button reads a picture first, otherwise text; a denied clipboard says to press Ctrl+V', async () => {
    const image = new Blob(['png'], { type: 'image/png' })
    const withImage = { read: async () => [{ types: ['text/html', 'image/png'], getType: async () => image }], readText: async () => 'ignored' } as unknown as Clipboard
    const result = await readClipboard(withImage)
    expect(result.kind).toBe('images')
    const withText = { read: async () => [{ types: ['text/plain'], getType: async () => new Blob([]) }], readText: async () => 'Колодки 0986494 1 шт' } as unknown as Clipboard
    expect(await readClipboard(withText)).toEqual({ kind: 'text', text: 'Колодки 0986494 1 шт' })
    const denied = { read: async () => { throw new Error('NotAllowedError') }, readText: async () => '' } as unknown as Clipboard
    await expect(readClipboard(denied)).rejects.toThrow(/Ctrl\+V/)
  })

  it('the order form pastes text outside input fields only, and has the clipboard button', () => {
    const form = readFileSync(new URL('./OrderFormPage.tsx', import.meta.url), 'utf8')
    expect(form).toContain('if (isEditableTarget(event.target) || !isRecognizableText(text)) return')
    expect(form).toContain('📋 Вставити з буфера')
    expect(form).toContain('placeRecognizedRow(row, (await productApi.search(row.sku, 10, { silent: true })).data ?? [])')
  })
})
