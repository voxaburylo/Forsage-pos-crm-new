import { useEffect, useRef } from 'react'

const IDLE_COMPLETE_MS = 220
const SEQUENCE_RESET_MS = 900
const TERMINATOR_GUARD_MS = 700
// Поріг «це сканер, а не людина»: людина не тримає 5+ символів поспіль
// зі швидкістю ≤90мс/символ, а сканери (навіть повільні Bluetooth) — тримають.
const FIELD_CHAR_GAP_MS = 120
const FIELD_AVG_INTERVAL_MS = 90
const FIELD_MIN_LENGTH = 5

function normalizeCode(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127 && !/\s/.test(character)
    })
    .join('')
    .trim()
}

function looksLikeBarcode(value: string): boolean {
  const code = normalizeCode(value)
  if (/^\d{5,}$/.test(code)) return true
  return code.length >= 6
    && /\d/.test(code)
    && /^[A-Za-z0-9._/-]+$/.test(code)
}

// React-контрольовані input'и приймають зміну лише через нативний сеттер +
// подію input — інакше React поверне старе значення при наступному рендері.
function stripScannedTail(el: Element | null, tail: string) {
  if (!tail) return
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
  const value = String(el.value ?? '')
  if (!value.endsWith(tail)) return
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value.slice(0, value.length - tail.length))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

interface ScannerOptions {
  onScan: (code: string) => void
}

/**
 * Глобальний HID-сканер каси.
 *
 * Поза полями вводу всі друковані клавіші належать сканеру (буфер + прихована
 * «поверхня»). Але й у явних полях (пошук, кількість, знижка, каса) сканер
 * МАЄ працювати: касир звично лишає курсор у пошуку і пікає далі. Тому в полях
 * ми відрізняємо чергу сканера від ручного набору за швидкістю: розпізнаний
 * код забираємо собі, а символи, що встигли надрукуватись у поле, — прибираємо.
 */
export function usePOSBarcodeScanner({ onScan }: ScannerOptions) {
  const scanCallback = useRef(onScan)

  useEffect(() => { scanCallback.current = onScan }, [onScan])

  useEffect(() => {
    let buffer = ''
    let lastAt = 0
    let terminatorGuardUntil = 0
    let prefixGuardUntil = 0
    let idleTimer: number | null = null

    // Окремий буфер для набору всередині явних полів вводу
    let fieldBuf = ''
    let fieldFirstAt = 0
    let fieldLastAt = 0
    const scannerSink = document.createElement('input')
    scannerSink.type = 'text'
    scannerSink.readOnly = true
    scannerSink.tabIndex = -1
    scannerSink.setAttribute('aria-hidden', 'true')
    scannerSink.dataset.posScannerCapture = 'true'
    scannerSink.style.position = 'fixed'
    scannerSink.style.left = '-10000px'
    scannerSink.style.top = '0'
    scannerSink.style.width = '1px'
    scannerSink.style.height = '1px'
    scannerSink.style.opacity = '0'
    scannerSink.style.pointerEvents = 'none'
    document.body.appendChild(scannerSink)

    const clearTimer = () => {
      if (idleTimer !== null) window.clearTimeout(idleTimer)
      idleTimer = null
    }

    const reset = () => {
      clearTimer()
      buffer = ''
      lastAt = 0
    }

    const resetField = () => {
      fieldBuf = ''
      fieldFirstAt = 0
      fieldLastAt = 0
    }

    const fieldBurstLooksLikeScan = () => {
      if (fieldBuf.length < FIELD_MIN_LENGTH) return false
      const avg = (fieldLastAt - fieldFirstAt) / (fieldBuf.length - 1)
      return avg <= FIELD_AVG_INTERVAL_MS
    }

    const focusScannerSurface = () => {
      const active = document.activeElement
      if (isExplicitInputMode(active)) return
      scannerSink.focus({ preventScroll: true })
    }

    const emitCode = (rawCode: string, event?: KeyboardEvent) => {
      const code = normalizeCode(rawCode)
      event?.preventDefault()
      event?.stopPropagation()
      event?.stopImmediatePropagation()
      reset()
      resetField()
      if (code) {
        terminatorGuardUntil = Date.now() + TERMINATOR_GUARD_MS
        focusScannerSurface()
        window.dispatchEvent(new CustomEvent('forsage:pos-scanner-stage', {
          detail: { stage: 'captured', code, at: Date.now() },
        }))
        scanCallback.current(code)
      }
    }

    const finishAfterIdle = () => {
      idleTimer = null
      if (looksLikeBarcode(buffer)) emitCode(buffer)
      else reset()
    }

    const isExplicitInputMode = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false
      if (element.dataset.posScannerCapture === 'true') return false
      if (element.dataset.posSearch === 'true' || element.dataset.scannerIgnore === 'true') return true
      return element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element.isContentEditable
    }

    // Після запуску браузер/PWA іноді відновлює фокус на старій кнопці або
    // полі. Один раз повертаємо його на поверхню сканера.
    const focusFrame = window.requestAnimationFrame(focusScannerSurface)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return

      // Префікс сканера: сканер магазину шле F7 перед КОЖНИМ кодом. Chrome на
      // F7 відкриває діалог «режим активного курсора» — екран «мигає», а цифри
      // летять у діалог замість каси. Глушимо F7 і відкриваємо вікно
      // захоплення: наступні пів секунди всі символи належать сканеру,
      // незалежно від того, де стоїть фокус.
      if (event.key === 'F7') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        reset()
        resetField()
        prefixGuardUntil = Date.now() + 500
        return
      }

      // Більшість HID-сканерів після коду надсилають Enter/Tab, а деякі — ще
      // й службові клавіші (F-клавіші, стрілки). У вікні одразу після скану
      // ковтаємо весь цей хвіст: він не має смикати браузер (фулскрін, меню)
      // чи переводити фокус на кнопки форм.
      if (
        !buffer && !fieldBuf
        && Date.now() <= terminatorGuardUntil
        && (event.key === 'Enter' || event.key === 'Tab'
          || (event.key.length > 1 && event.key !== 'Escape' && event.key !== 'Shift'))
      ) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        return
      }

      // Фокус у явному полі (пошук, кількість, знижка, каса). Ручний набір
      // належить полю, але чергу сканера розпізнаємо за швидкістю і забираємо:
      // саме тут раніше скани «зникали через раз», коли курсор стояв у пошуку.
      // Після префікса F7 поля пропускаємо повністю — код точно від сканера.
      const activeEl = document.activeElement
      if (isExplicitInputMode(activeEl) && Date.now() > prefixGuardUntil) {
        reset()
        if (event.key === 'Enter' || event.key === 'Tab') {
          const now = Date.now()
          if (fieldBuf && now - fieldLastAt <= 250 && fieldBurstLooksLikeScan()) {
            const code = fieldBuf
            // Код встиг надрукуватись у поле — прибираємо його звідти
            stripScannedTail(activeEl, code)
            emitCode(code, event)
          } else {
            resetField()
          }
          return
        }
        if (event.key.length !== 1) {
          resetField()
          return
        }
        const now = Date.now()
        if (fieldBuf && now - fieldLastAt > FIELD_CHAR_GAP_MS) resetField()
        if (!fieldBuf) fieldFirstAt = now
        fieldBuf += event.key
        fieldLastAt = now
        // 13 цифр на швидкості сканера — завершуємо одразу, як і поза полями.
        // Поточний символ ще НЕ в полі (keydown) — глушимо його і прибираємо
        // з поля лише попередні 12.
        if (/^\d{13}$/.test(fieldBuf) && fieldBurstLooksLikeScan()) {
          const code = fieldBuf
          stripScannedTail(activeEl, code.slice(0, -1))
          emitCode(code, event)
        }
        return
      }
      resetField()

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (buffer) emitCode(buffer, event)
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
        emitCode(buffer, event)
        return
      }

      clearTimer()
      idleTimer = window.setTimeout(finishAfterIdle, IDLE_COMPLETE_MS)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      clearTimer()
      window.removeEventListener('keydown', handleKeyDown, true)
      scannerSink.remove()
    }
  }, [])
}
