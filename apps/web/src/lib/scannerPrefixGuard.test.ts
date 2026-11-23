import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { installScannerPrefixGuard, isScannerPrefixKey } from './scannerPrefixGuard'

// 23.11.2026: «у Chrome сканер вводить, у стандартному браузері Windows — одну цифру». Сканер шле F7 перед кодом,
// F7 у Edge/Chrome відкриває вікно «режим каретки» і забирає фокус. Перевірено в справжньому Edge 158 і Chrome 157:
// до виправлення F7 на сторінці входу не глушився, після — глушиться, і всі 13 цифр лягають у поле.
describe('the scanner prefix never opens a browser window', () => {
  it('blocks only plain F7, so the event still reaches the till scanner', () => {
    const listeners: Array<{ handler: (event: any) => void; options: unknown }> = []
    installScannerPrefixGuard({ addEventListener: ((type: string, handler: any, options: unknown) => { expect(type).toBe('keydown'); listeners.push({ handler, options }) }) as any })
    expect(listeners[0].options).toEqual({ capture: true })
    const event = (key: string, mods: Partial<KeyboardEvent> = {}) => {
      const state = { prevented: false, stopped: false }
      listeners[0].handler({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods,
        preventDefault: () => { state.prevented = true }, stopPropagation: () => { state.stopped = true }, stopImmediatePropagation: () => { state.stopped = true } })
      return state
    }
    expect(event('F7')).toEqual({ prevented: true, stopped: false })
    expect(event('F7', { ctrlKey: true }).prevented).toBe(false)
    expect(event('7').prevented).toBe(false)
    expect(event('F5').prevented).toBe(false)
    expect(isScannerPrefixKey({ key: 'F7', ctrlKey: false, altKey: false, metaKey: false, shiftKey: true })).toBe(false)
  })

  it('is installed first, for every screen', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    expect(main.indexOf('installScannerPrefixGuard()')).toBeGreaterThan(0)
    expect(main.indexOf('installScannerPrefixGuard()')).toBeLessThan(main.indexOf('installLocalDiagnostics()'))
  })
})
