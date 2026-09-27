import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { documentRevision, requireDocumentRevision } from '../src/repositories/documentRevision'
import { localizeDesktopIpcError } from '../src/ipcError'

it.each([undefined, null, '', 'old-version', 123, 'f'.repeat(63)])('rejects a missing/invalid client revision %s', revision => {
  expect(() => requireDocumentRevision(revision)).toThrow('DOCUMENT_CONFLICT')
})
it('accepts the content revision and preserves the conflict protocol through IPC translation', () => {
  const revision = documentRevision(['invoice', 98])
  expect(requireDocumentRevision(revision)).toBe(revision)
  expect(localizeDesktopIpcError(new Error('DOCUMENT_CONFLICT: Позиція змінилася')).message).toContain('DOCUMENT_CONFLICT')
})
it.each(['update-invoice', 'pay-invoice', 'post-invoice', 'cancel-invoice', 'delete-invoice'])('requires the reviewed revision at the %s IPC/LAN entry point', action => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf(`handleDesktopIpc('desktop:supply:${action}'`)).split('\n  )')[0]
  expect(handler).toContain('requireDocumentRevision(')
})
it('requires revision for absolute inventory quantity writes', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf("handleDesktopIpc('desktop:inventory:set-item-qty'")).split('\n  )')[0]
  expect(handler).toContain('requireDocumentRevision(')
})
