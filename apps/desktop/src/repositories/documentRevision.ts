import { createHash } from 'node:crypto'

/** A content revision does not depend on clock resolution or a new DB column. */
export function documentRevision(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** User-facing IPC/LAN writes must never fall back to the legacy optional contract. */
export function requireDocumentRevision(expected: unknown): string {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('DOCUMENT_CONFLICT: Немає версії документа для безпечного запису. Оновіть програму та відкрийте документ заново. Ваші правки не застосовано.')
  }
  return expected
}

export function assertDocumentRevision(actual: string, expected: unknown, label: string): void {
  // Optional for older internal callers. New editing clients must keep and send
  // the token of the document they actually opened, never silently rebase it.
  if (expected === undefined) return
  if (typeof expected !== 'string' || expected !== actual) {
    throw new Error(`DOCUMENT_CONFLICT: ${label} змінилася після відкриття. Ваші правки збережені у формі. Звірте актуальну версію перед продовженням.`)
  }
}
