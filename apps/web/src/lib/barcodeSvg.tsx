import JsBarcode from 'jsbarcode'

export interface BarcodeSvgOptions {
  width?: number
  height?: number
}

/**
 * Creates a high-resolution raster barcode synchronously before print.
 *
 * react-barcode cannot be rendered with renderToStaticMarkup: its bars are
 * drawn through a ref after mounting, so SSR produces only <svg></svg>.
 * Some thermal printer drivers also skip inline SVG in Chrome preview, while
 * an embedded PNG is handled reliably by both preview and the spooler.
 */
export function renderBarcodeSvg(value: string, options: BarcodeSvgOptions = {}): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || typeof document === 'undefined') return ''

  try {
    const scale = 3
    const canvas = document.createElement('canvas')

    JsBarcode(canvas, normalized, {
      format: 'CODE128',
      width: (options.width ?? 1.2) * scale,
      height: (options.height ?? 28) * scale,
      margin: 0,
      displayValue: false,
      background: '#ffffff',
      lineColor: '#000000',
    })

    const displayWidth = Math.max(1, Math.round(canvas.width / scale))
    const displayHeight = Math.max(1, Math.round(canvas.height / scale))
    // data-code/data-modules читає прямий TSPL-друк на desktop: він ховає цю
    // картинку і замість неї друкує рідний BARCODE принтера (крапка-в-крапку).
    const modules = Math.max(1, Math.round(canvas.width / ((options.width ?? 1.2) * scale)))
    const codeAttr = /[\x20-\x7e]+/.test(normalized) && !/[^\x20-\x7e]/.test(normalized)
      ? ` data-code="${normalized.replace(/"/g, '')}" data-modules="${modules}"`
      : ''
    return `<img class="barcode-raster"${codeAttr} src="${canvas.toDataURL('image/png')}" width="${displayWidth}" height="${displayHeight}" alt="">`
  } catch (error) {
    console.error('Failed to generate barcode image', error)
    return ''
  }
}
