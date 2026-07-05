import { useEffect, useRef } from 'react'

const IDLE_COMPLETE_MS = 220
const SEQUENCE_RESET_MS = 900

function normalizeCode(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\s]/g, '').trim()
}

function looksLikeBarcode(value: string): boolean {
  const code = normalizeCode(value)
  if (/^\d{5,}$/.test(code)) return true
  return code.length >= 6
    && /\d/.test(code)
    && /^[A-Za-z0-9._/-]+$/.test(code)
}

interface ScannerOptions {
  onScan: (code: string) => void
}

/**
 * Глобальний HID-сканер каси.
 *
 * За замовчуванням усі друковані клавіші належать сканеру. Звичайний ввід
 * дозволений лише у полі, яке касир явно вибрав (пошук, кількість, сума тощо).
 * Це прибирає класифікацію "ручний текст чи скан" із критичного шляху.
 */
export function usePOSBarcodeScanner({ onScan }: ScannerOptions) {
  const scanCallback = useRef(onScan)

  useEffect(() => { scanCallback.current = onScan }, [onScan])

  useEffect(() => {
    let buffer = ''
    let lastAt = 0
    let idleTimer: number | null = null

    const clearTimer = () => {
      if (idleTimer !== null) window.clearTimeout(idleTimer)
      idleTimer = null
    }

    const reset = () => {
      clearTimer()
      buffer = ''
      lastAt = 0
    }

    const emitScan = (event?: KeyboardEvent) => {
      const code = normalizeCode(buffer)
      event?.preventDefault()
      event?.stopPropagation()
      event?.stopImmediatePropagation()
      reset()
      if (code) scanCallback.current(code)
    }

    const finishAfterIdle = () => {
      idleTimer = null
      if (looksLikeBarcode(buffer)) emitScan()
      else reset()
    }

    const isExplicitInputMode = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false
      if (element.dataset.posSearch === 'true' || element.dataset.scannerIgnore === 'true') return true
      return element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element.isContentEditable
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return

      // Касир натиснув конкретне поле — сканер не втручається в його ввід.
      if (isExplicitInputMode(document.activeElement)) {
        reset()
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (buffer) emitScan(event)
        return
      }

      if (event.key.length !== 1) return

      const now = Date.now()
      if (buffer && now - lastAt > SEQUENCE_RESET_MS) reset()

      // Не даємо жодному символу сканера потрапити в кнопки/гарячі клавіші POS.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      buffer += event.key
      lastAt = now

      // Основний формат магазину — 13 цифр. Завершуємо відразу, без очікування
      // Enter та без перевірки контрольної цифри: у базі можуть бути власні коди.
      if (/^\d{13}$/.test(buffer)) {
        emitScan(event)
        return
      }

      clearTimer()
      idleTimer = window.setTimeout(finishAfterIdle, IDLE_COMPLETE_MS)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      clearTimer()
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [])
}
