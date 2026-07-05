import { renderToStaticMarkup } from 'react-dom/server'
import Barcode from 'react-barcode'

export interface BarcodeSvgOptions {
  width?: number
  height?: number
}

/**
 * Generates the barcode inside the application bundle.
 * Printing must not depend on a CDN: a slow/offline connection used to produce
 * an empty label or start the print dialog before the barcode was ready.
 */
export function renderBarcodeSvg(value: string, options: BarcodeSvgOptions = {}): string {
  if (!value) return ''

  return renderToStaticMarkup(
    <Barcode
      value={value}
      format="CODE128"
      width={options.width ?? 1.2}
      height={options.height ?? 28}
      margin={0}
      displayValue={false}
      background="#ffffff"
      lineColor="#000000"
      renderer="svg"
    />,
  )
}
