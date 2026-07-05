import { useEffect, useRef } from 'react'

const IDLE_COMPLETE_MS = 140
const SEQUENCE_RESET_MS = 700

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
  onManualSearchText: (text: string) => void
}

/**
 * Єдиний власник клавіатурного сканера в POS.
 *
 * Символи не потрапляють у видимий пошук, доки послідовність не класифікована:
 * штрихкод іде прямо в кошик, звичайний текст — окремо в ручний пошук.
 */
export function usePOSBarcodeScanner({ onScan, onManualSearchText }: ScannerOptions) {
  const scanCallback = useRef(onScan)
  const manualTextCallback = useRef(onManualSearchText)

  useEffect(() => { scanCallback.current = onScan }, [onScan])
  useEffect(() => { manualTextCallback.current = onManualSearchText }, [onManualSearchText])

  useEffect(() => {
    let buffer = ''
    let firstAt = 0
    let lastAt = 0
    let idleTimer: number | null = null
    let target: HTMLInputElement | HTMLTextAreaElement | null = null
    let valueBefore = ''
    let searchFocused = false

    const clearTimer = () => {
      if (idleTimer !== null) window.clearTimeout(idleTimer)
      idleTimer = null
    }

    const reset = () => {
      clearTimer()
      buffer = ''
      firstAt = 0
      lastAt = 0
      target = null
      valueBefore = ''
      searchFocused = false
    }

    const restoreEditableTarget = () => {
      if (!target || searchFocused) return
      const proto = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      setter?.call(target, valueBefore)
      target.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const emitScan = (event?: KeyboardEvent) => {
      const code = normalizeCode(buffer)
      if (!code) {
        reset()
        return
      }
      event?.preventDefault()
      event?.stopPropagation()
      event?.stopImmediatePropagation()
      restoreEditableTarget()
      reset()
      scanCallback.current(code)
    }

    const flushManualSearch = () => {
      const text = buffer
      reset()
      if (text) manualTextCallback.current(text)
    }

    const finishAfterIdle = () => {
      idleTimer = null
      if (looksLikeBarcode(buffer)) {
        emitScan()
      } else if (searchFocused) {
        flushManualSearch()
      } else {
        reset()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
      const now = Date.now()

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!buffer) return
        const averageInterval = buffer.length > 1
          ? (lastAt - firstAt) / (buffer.length - 1)
          : Number.POSITIVE_INFINITY
        if (looksLikeBarcode(buffer) || (buffer.length >= 4 && averageInterval <= 350)) {
          emitScan(event)
        } else if (searchFocused) {
          flushManualSearch()
        } else {
          reset()
        }
        return
      }

      if (event.key.length !== 1) {
        if (event.key !== 'Shift' && event.key !== 'CapsLock') reset()
        return
      }

      if (buffer && now - lastAt > SEQUENCE_RESET_MS) {
        if (searchFocused) flushManualSearch()
        else reset()
      }

      if (!buffer) {
        firstAt = now
        const active = document.activeElement
        target = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
          ? active
          : null
        valueBefore = target?.value ?? ''
        searchFocused = target?.dataset.posSearch === 'true'
      }

      buffer += event.key
      lastAt = now

      const averageInterval = buffer.length > 1
        ? (lastAt - firstAt) / (buffer.length - 1)
        : Number.POSITIVE_INFINITY

      if (searchFocused) {
        // Пошук отримує лише вже класифікований ручний текст, не сирі клавіші.
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
      } else if (buffer.length >= 3 && averageInterval <= 250) {
        // У стороннє поле могли потрапити лише перші два символи; при завершенні
        // скану значення буде атомарно відновлено.
        event.preventDefault()
        event.stopPropagation()
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
