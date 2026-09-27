import { session, type Session } from 'electron'

export const PRINT_DOCUMENT_SCHEME = 'forsage-print'
const documents = new Map<string, string>()
let printSession: Session | undefined

// Only print windows use this memory-only session. No shop cookies, storage,
// temporary customer files, external requests or page scripts are needed.
export function getPrintSession(): Session {
  if (printSession) return printSession
  const isolated = session.fromPartition('forsage-print-memory', { cache: false })
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(PRINT_DOCUMENT_SCHEME + ':') && !details.url.startsWith('data:') && !details.url.startsWith('blob:') })
  })
  isolated.protocol.handle(PRINT_DOCUMENT_SCHEME, request => {
    const html = request.method === 'GET' ? documents.get(request.url) : undefined
    return new Response(html ?? '', {
      status: html === undefined ? 404 : 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'",
      },
    })
  })
  printSession = isolated
  return isolated
}

export function registerPrintDocument(url: string, html: string): () => void {
  documents.set(url, html)
  return () => { documents.delete(url) }
}
