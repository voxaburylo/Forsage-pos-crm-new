import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8')

describe('аварійне відновлення локальної бази', () => {
  it('вимагає підтвердження та спершу робить локальну копію', () => {
    const start = page.indexOf('async function handleBootstrapDesktop')
    const body = page.slice(start, page.indexOf('async function testAiKey'))
    expect(body).toContain('window.confirm')
    expect(body).toContain('backupNow()')
    expect(body.indexOf('backupNow()')).toBeLessThan(body.indexOf('bootstrapDesktopFromServer()'))
  })
})
