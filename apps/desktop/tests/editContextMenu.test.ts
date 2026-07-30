import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

describe('desktop text context menu', () => {
  it('is installed for every BrowserWindow', () => {
    expect(mainSource).toContain("app.on('browser-window-created'")
    expect(mainSource).toContain("window.webContents.on('context-menu'")
  })

  it('provides the standard editable text actions', () => {
    expect(mainSource).toContain("role: 'cut'")
    expect(mainSource).toContain("role: 'copy'")
    expect(mainSource).toContain("role: 'paste'")
    expect(mainSource).toContain("role: 'selectAll'")
    expect(mainSource).toContain("label: 'Вставити'")
    expect(mainSource).toContain("label: 'Копіювати'")
  })
})
