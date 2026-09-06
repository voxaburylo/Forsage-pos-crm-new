import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8')

describe('захист робочої локальної бази', () => {
  it('не пропонує підміняти робочу базу серверною копією', () => {
    expect(page).not.toContain('handleBootstrapDesktop')
    expect(page).not.toContain('bootstrapDesktopFromServer')
    expect(page).toContain('Зворотне завантаження в робочу базу заборонене')
    expect(page).toContain('<BackupSettingsCard />')
  })
})
