import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { installDialogFocusRepair } from './dialogFocusRepair'

describe('keyboard input after a system confirm/alert window (owner complaint 22.11.2026)', () => {
  it('asks the shell to restore focus after every confirm and alert, keeping the answer', () => {
    const answers = [true, false]
    const host = { confirm: vi.fn(() => answers.shift()!), alert: vi.fn() }
    const repair = vi.fn()
    installDialogFocusRepair(host, repair)
    expect(host.confirm('Видалити?')).toBe(true)
    expect(host.confirm('Видалити?')).toBe(false)
    host.alert('Готово')
    expect(repair).toHaveBeenCalledTimes(3)
  })
  it('restores focus even when the dialog throws, never breaks the action, and installs once', () => {
    const native = vi.fn(() => { throw new Error('dialogs blocked') })
    const host = { confirm: native, alert: vi.fn() }
    const repair = vi.fn(() => { throw new Error('shell is gone') })
    installDialogFocusRepair(host, repair)
    const wrapped = host.confirm
    installDialogFocusRepair(host, repair)
    expect(host.confirm).toBe(wrapped)
    expect(() => host.confirm('x')).toThrow('dialogs blocked')
    expect(repair).toHaveBeenCalledTimes(1)
    expect(() => host.alert('x')).not.toThrow()
  })
  it('is installed at program start and the shell answers only its own window', () => {
    expect(readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')).toContain('installDialogFocusRepair()')
    const main = readFileSync(new URL('../../../desktop/src/main.ts', import.meta.url), 'utf8')
    const handler = main.slice(main.indexOf("ipcMain.on('desktop:window:restore-input-focus'"), main.indexOf("ipcMain.on('desktop:diagnostic-event'"))
    expect(handler).toContain('event.sender.id !== mainWindow.webContents.id')
    expect(handler).toContain('mainWindow.blur()')
    expect(handler).toContain('mainWindow.webContents.focus()')
  })
})
