import { randomUUID } from 'node:crypto'
import { getPrintSession, PRINT_DOCUMENT_SCHEME, registerPrintDocument } from './printSession'

interface PrintDocumentTarget {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  webContents: { session: Electron.Session }
}

// Load the document as a native response, not a data URL followed by a second
// document.open/write navigation. A fresh URL prevents reuse of a failed page.
// Retrying this PREPARATION step cannot duplicate a physical printer job.
export async function loadPrintHtml(target: PrintDocumentTarget, html: string): Promise<void> {
  if (typeof html !== 'string' || !html.trim()) throw new Error('PRINT_HTML_EMPTY')
  if (target.webContents.session !== getPrintSession()) throw new Error('PRINT_SESSION_REQUIRED')
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = `${PRINT_DOCUMENT_SCHEME}://document/${randomUUID()}`
    const release = registerPrintDocument(url, html)
    try {
      if (target.isDestroyed()) throw new Error('PRINT_RENDERER_DESTROYED')
      await target.loadURL(url)
      return
    } catch (error) {
      const code = error instanceof Error ? error.message.match(/\bERR_[A-Z_]+\b/)?.[0] : undefined
      if (attempt === 0 && !target.isDestroyed() && (code === 'ERR_FAILED' || code === 'ERR_ABORTED')) {
        await new Promise(resolve => setTimeout(resolve, 300))
      } else {
        throw new Error('PRINT_DOCUMENT_LOAD_FAILED' + (code ? ` (${code})` : ''))
      }
    } finally { release() }
  }
}
