import JsBarcode from 'jsbarcode'

export interface BarcodeSvgOptions {
  width?: number
  height?: number
}

/**
 * Creates a complete SVG synchronously before the print dialog opens.
 *
 * react-barcode cannot be rendered with renderToStaticMarkup: its bars are
 * drawn through a ref after mounting, so SSR produces only <svg></svg>.
 */
export function renderBarcodeSvg(value: string, options: BarcodeSvgOptions = {}): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || typeof document === 'undefined') return ''

  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', `Штрихкод ${normalized}`)

    JsBarcode(svg, normalized, {
      format: 'CODE128',
      width: options.width ?? 1.2,
      height: options.height ?? 28,
      margin: 0,
      displayValue: false,
      background: '#ffffff',
      lineColor: '#000000',
    })

    return svg.outerHTML
  } catch (error) {
    console.error('Failed to generate barcode SVG', error)
    return ''
  }
}
