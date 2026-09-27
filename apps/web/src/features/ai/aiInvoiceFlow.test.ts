import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const page = readFileSync(new URL('./AiAssistantPage.tsx', import.meta.url), 'utf8')
describe('AI invoice confirmation lifecycle', () => {
  it('unlocks recognition before cleanup so a ready table can be confirmed', () => {
    const send = page.slice(page.indexOf('async function send('), page.indexOf('const applyBusy'))
    expect(send).toMatch(/finally\s*\{\s*sendBusy.current = false\s*if \(isCurrentContext\(\)\) \{ setSendingProgress/)
    expect(send.indexOf('sendBusy.current = false', send.lastIndexOf('finally'))).toBeLessThan(send.lastIndexOf('await removeProcessingUploads'))
  })
  it('opens the full invoice review directly and suppresses the duplicate short table', () => {
    expect(page).toContain('if (invoiceAction) setModalAction(invoiceAction)')
    expect(page).toContain(') : isInvoice ? null : isBulk')
  })
  it('does not use confirming an action to unlock a different recognition operation', () => {
    const apply = page.slice(page.indexOf('async function applyAction('), page.indexOf('function onKeyDown('))
    expect(apply).not.toContain('sendBusy.current = false')
    expect(apply).toContain('applyBusy.current = false')
  })
})
