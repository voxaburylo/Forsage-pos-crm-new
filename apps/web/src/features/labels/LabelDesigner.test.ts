import { describe, expect, it, vi } from 'vitest'
import { buildLabelPrintDocument, DEFAULT_LABEL, DEMO_PRODUCT } from './LabelDesigner'

vi.mock('@/lib/barcodeSvg', () => ({
  renderBarcodeSvg: () => '<img class="barcode-raster" src="data:image/png;base64,test" alt="">',
}))

function product(name = 'Тестовий товар') {
  return {
    ...DEMO_PRODUCT,
    id: 'product-1',
    name,
    sku: 'SKU-1',
    barcode: '2003093555486',
  }
}

describe('label print document', () => {
  it('uses the designer geometry and creates exactly one section per label', () => {
    const settings = {
      ...DEFAULT_LABEL,
      width_mm: 58,
      height_mm: 40,
      padding_mm: 2,
      offset_x_mm: 1.5,
      offset_y_mm: -0.5,
      show_shop_name: false,
      show_sku: false,
      show_storage_bin: false,
      show_price: false,
      font_size: 9,
      barcode_height: 31,
      barcode_width_factor: 0.5,
      pos_barcode: { x: 10, y: 42 },
      align_barcode: 'center' as const,
    }

    const document = buildLabelPrintDocument(settings, [product(), product('Другий товар')], false)

    expect(document.count).toBe(2)
    expect(document.html.match(/<section class="label-page/g)).toHaveLength(2)
    expect(document.html.match(/class="label-page has-next"/g)).toHaveLength(1)
    expect(document.html).toContain('@page { margin: 0; size: 58mm 40mm; }')
    expect(document.html).toContain('height: calc(40mm - 0.01mm) !important;')
    expect(document.html).toContain('transform: translate(1.5mm, -0.5mm)')
    expect(document.html).toContain('left:10%;top:42%;width:40%')
    expect(document.html).toContain('height: 31px')
    expect(document.html).toContain('font-size: 9pt')
    expect(document.html).not.toContain('Форсаж')
    expect(document.html).not.toContain('SKU-1')
    expect(document.html).not.toContain('650.00 ₴')
  })

  it('escapes product text in the printable document', () => {
    const settings = { ...DEFAULT_LABEL, show_shop_name: false, show_barcode: false }
    const document = buildLabelPrintDocument(settings, [product('<гайка & болт>')], false)
    expect(document.html).toContain('&lt;гайка &amp; болт&gt;')
    expect(document.html).not.toContain('<гайка & болт>')
  })
})
