import { describe, expect, it, vi } from 'vitest'
import { rememberLink, rememberedLink } from '@/components/TillOnly'
import { NATIVE_SCAN_CLASS, scanOverlay } from './nativeCamera'

// 27.11.2026, проба застосунку на Android: «швидкість низька; кнопка сканера відкриває камеру — це довго».
describe('screens do not wait for the main-PC check every time', () => {
  it('the last answer is remembered for a few minutes, then asked again', () => {
    const now = 1_000_000
    expect(rememberedLink(now)).toBe('checking')
    rememberLink('online', now)
    expect(rememberedLink(now + 60_000)).toBe('online')
    expect(rememberedLink(now + 4 * 60_000)).toBe('checking')
    rememberLink('offline', now)
    expect(rememberedLink(now + 1_000)).toBe('offline')
  })
})

/** Найпростіша заміна документа: тестам вистачає тегів, атрибутів і натискання. */
function fakeDocument() {
  const element = (tag: string) => {
    const attributes = new Map<string, string>(), children: any[] = [], listeners = new Map<string, () => void>()
    return { tag, attributes, children, textContent: '', type: '',
      setAttribute: (name: string, value: string) => { attributes.set(name, value) },
      addEventListener: (name: string, handler: () => void) => { listeners.set(name, handler) },
      append: (...nodes: any[]) => { children.push(...nodes) },
      click: () => listeners.get('click')?.() }
  }
  return { createElement: element } as unknown as Document
}

describe('the in-app scanner screen', () => {
  it('has a hint, a frame and a cancel button; everything else is hidden by one class', () => {
    const cancel = vi.fn()
    const overlay = scanOverlay(fakeDocument(), cancel) as any
    expect(overlay.attributes.has('data-native-scan-overlay')).toBe(true)
    const [hint, frame, button] = overlay.children
    expect(hint.textContent).toBe('Наведіть камеру на штрихкод')
    expect(frame.attributes.has('data-native-scan-frame')).toBe(true)
    expect(button.textContent).toBe('Скасувати')
    button.click()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(NATIVE_SCAN_CLASS).toBe('forsage-native-scan')
  })
})
