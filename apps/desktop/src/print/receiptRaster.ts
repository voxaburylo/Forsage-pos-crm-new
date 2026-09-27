import { BrowserWindow, nativeImage } from 'electron'
import { withPrintTimeout } from './printTimeout'
import { loadPrintHtml } from './loadPrintHtml'
import { getPrintSession } from './printSession'
import { assertPrintRuntimeFiles } from './printRuntime'

export interface ReceiptPrinterProfile { widthDots: number; dpiX: number; dpiY: number }
// A hidden renderer can emit a correctly sized, but still blank resize frame.
// Never accept that frame as the receipt, even after the DOM is ready.
export function receiptFrameHasInk(frame: Electron.NativeImage, width?: number, height?: number): boolean {
  const pixels = frame.toBitmap({ scaleFactor: 1 })
  const size = width === undefined ? undefined : frame.getSize(1)
  for (let i = 0; i < pixels.length; i += 4) {
    if (size && ((i / 4) % size.width >= width! || Math.floor(i / 4 / size.width) >= height!)) continue
    const alpha = pixels[i + 3] / 255
    const luma = (29 * pixels[i] + 150 * pixels[i + 1] + 77 * pixels[i + 2]) / 256
    if (luma * alpha + 255 * (1 - alpha) < 160) return true
  }
  return false
}
// A resized compositor surface may contain the old 600px image at the top
// and blank pixels below. Top-of-page ink alone does not prove a full frame.
// A paint fence is placed in the unprinted right/bottom safety gutter.
export function receiptFrameHasFence(frame: Electron.NativeImage, width: number, height: number): boolean {
  const size = frame.getSize(1)
  if (size.width <= width || size.height <= height) return false
  const pixels = frame.toBitmap({ scaleFactor: 1 })
  const offset = (height * size.width + width) * 4
  return pixels[offset] < 32 && pixels[offset + 1] < 32 && pixels[offset + 2] < 32 && pixels[offset + 3] > 240
}
export function receiptRasterLayout(profile: ReceiptPrinterProfile) {
  const { widthDots, dpiX, dpiY } = profile
  if (![widthDots, dpiX, dpiY].every(Number.isFinite) || !Number.isInteger(widthDots) || widthDots < 100 || widthDots > 1500 || dpiX < 100 || dpiX > 600 || dpiY !== dpiX) throw new Error('PRINT_RECEIPT_INVALID_RESOLUTION')
  if (widthDots / dpiX * 25.4 > 59) throw new Error('PRINT_RECEIPT_INVALID_PAPER')
  return { widthDots, cssWidth: widthDots * 96 / dpiX, zoom: dpiX / 96 }
}

export async function monochromeReceipt(bgra: Buffer, sourceWidth: number, sourceHeight: number, width: number, height: number): Promise<Buffer> {
  if (![sourceWidth, sourceHeight, width, height].every(n => Number.isInteger(n) && n > 0) || sourceWidth < width || sourceHeight < height || width > 1500 || height > 16000 || bgra.length !== sourceWidth * sourceHeight * 4) throw new Error('PRINT_RECEIPT_SIZE_INVALID')
  const output = Buffer.alloc(width * height * 4, 255)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * sourceWidth + x) * 4, dst = (y * width + x) * 4
      const alpha = bgra[src + 3] / 255
      const luminance = (29 * bgra[src] + 150 * bgra[src + 1] + 77 * bgra[src + 2]) / 256
      const value = luminance * alpha + 255 * (1 - alpha) < 160 ? 0 : 255
      output[dst] = output[dst + 1] = output[dst + 2] = value
    }
    if (y % 128 === 127) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return output
}

// Dedicated offscreen rendering fixes DPR at 1. Display zoom (125%, 150%, etc.)
// must never change printer pixels. The receipt reflows to the actual head width;
// it is not a 58/80 mm screenshot squeezed to 48 mm afterwards.
export async function renderReceiptRaster(html: string, profile: ReceiptPrinterProfile): Promise<Buffer> {
  const layout = receiptRasterLayout(profile)
  assertPrintRuntimeFiles()
  const render = new BrowserWindow({ show: false, width: layout.widthDots + 2, height: 600, useContentSize: true, frame: false, backgroundColor: '#ffffff', webPreferences: { session: getPrintSession(), offscreen: { deviceScaleFactor: 1 }, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const stop = () => { if (!render.isDestroyed()) render.destroy() }
  const stage = <T>(promise: Promise<T>) => withPrintTimeout(promise, 10_000, 'PRINT_RENDER_TIMEOUT', stop)
  try {
    render.webContents.setFrameRate(30)
    render.webContents.startPainting()
    await stage(loadPrintHtml(render, html))
    render.webContents.setZoomFactor(layout.zoom)
    await stage(render.webContents.insertCSS('html,body{margin:0!important;padding:0!important;background:#fff!important;width:' + layout.cssWidth + 'px!important;min-width:0!important;overflow:hidden!important} .receipt-print{display:block!important;position:static!important;margin:0!important;box-sizing:border-box!important;width:' + layout.cssWidth + 'px!important;max-width:none!important;min-width:0!important;padding:2mm 1mm 6mm!important} ::-webkit-scrollbar{display:none}'))
    await stage(render.webContents.executeJavaScript('Promise.all([document.fonts.ready,...Array.from(document.images).map(img=>img.decode())])'))
    const height = await stage(render.webContents.executeJavaScript('(() => {const el=document.querySelector(".receipt-print")||document.body;return Math.ceil(Math.max(el.getBoundingClientRect().height,el.scrollHeight)*' + layout.zoom + ')})()')) as number
    if (!Number.isInteger(height) || height < 1 || height > 16000) throw new Error('PRINT_RECEIPT_SIZE_INVALID')
    render.setContentSize(layout.widthDots + 2, height + 2)
    await stage(render.webContents.executeJavaScript(`(() => {
      const fence=document.createElement('div');
      fence.setAttribute('aria-hidden','true');
      fence.style.cssText='position:fixed!important;z-index:2147483647!important;pointer-events:none!important;left:${layout.cssWidth}px!important;top:${height / layout.zoom}px!important;width:${4 / layout.zoom}px!important;height:${4 / layout.zoom}px!important;background:#000!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;';
      document.documentElement.appendChild(fence);
      return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    })()`))
    // Electron capturePage can resample offscreen output to the DISPLAY scale.
    // The paint frame is the native offscreen bitmap at our fixed DPR=1.
    let removePaintListener = () => {}
    let capture: Electron.NativeImage
    try {
      capture = await stage(new Promise<Electron.NativeImage>(resolve => {
        const onPaint = (_event: Electron.Event, _dirty: Electron.Rectangle, frame: Electron.NativeImage) => {
          const size = frame.getSize(1)
          // Fractional desktop scaling can round the window's DIP dimensions
          // by a pixel. Only the blank safety border may vary; never rescale.
          if (size.width > layout.widthDots && size.width <= layout.widthDots + 4 && size.height > height && size.height <= height + 4 && receiptFrameHasFence(frame, layout.widthDots, height) && receiptFrameHasInk(frame, layout.widthDots, height)) resolve(frame)
        }
        // Invalidation only repaints this hidden preview; it never sends or
        // retries a physical print job. The existing deadline bounds the wait.
        const repaint = setInterval(() => { if (!render.isDestroyed()) render.webContents.invalidate() }, 100)
        removePaintListener = () => {
          clearInterval(repaint)
          if (!render.isDestroyed()) render.webContents.removeListener('paint', onPaint)
        }
        render.webContents.on('paint', onPaint)
        render.webContents.invalidate()
      }))
    } finally { removePaintListener() }
    const size = capture.getSize(1)
    // Allow only the blank viewport safety border and DIP rounding, never a
    // scaled screenshot. Fail safely instead of silently resampling small text.
    if (size.width < layout.widthDots || size.width > layout.widthDots + 4 || size.height < height || size.height > height + 4) throw new Error('PRINT_RECEIPT_CAPTURE_SCALE')
    const pixels = await monochromeReceipt(capture.toBitmap({ scaleFactor: 1 }), size.width, size.height, layout.widthDots, height)
    return nativeImage.createFromBitmap(pixels, { width: layout.widthDots, height, scaleFactor: 1 }).toPNG()
  } finally { stop() }
}
