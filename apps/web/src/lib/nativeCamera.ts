import { firstCode, nativeFormats } from './nativeScan'

/**
 * Швидкий сканер у застосунку (27.11.2026, слово власника після проби на Android: «кнопка сканера відкриває камеру —
 * це довго»). Перший варіант відкривав окремий екран сканера Google — він запускається секунду-дві. Тут камера
 * вмикається всередині самого застосунку (за екраном програми), без переходу в інший екран: екран програми на час
 * сканування ховається, видно камеру, рамку й кнопку «Скасувати». Перший зчитаний код — і все повертається як було.
 * Якщо так запустити не вдалося (старий телефон, немає дозволу) — лишається попередній сканер Google (nativeScan).
 */
export const NATIVE_SCAN_CLASS = 'forsage-native-scan'
const OVERLAY_ATTRIBUTE = 'data-native-scan-overlay'

export class CameraDenied extends Error {}

export interface CameraScan { done: Promise<string | null>; cancel: () => void }

/** Рамка й кнопка поверх камери. Усе інше на екрані в цей час сховане (правила в index.css). */
export function scanOverlay(doc: Document, onCancel: () => void): HTMLElement {
  const overlay = doc.createElement('div')
  overlay.setAttribute(OVERLAY_ATTRIBUTE, '')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', 'Сканування штрихкоду')
  const hint = doc.createElement('p')
  hint.textContent = 'Наведіть камеру на штрихкод'
  const frame = doc.createElement('div')
  frame.setAttribute('data-native-scan-frame', '')
  const button = doc.createElement('button')
  button.type = 'button'
  button.textContent = 'Скасувати'
  button.addEventListener('click', onCancel)
  overlay.append(hint, frame, button)
  return overlay
}

/**
 * Сканер «як справжній» (27.11.2026, слово власника: «камера мені не потрібна — треба, щоб прямо в рядку зловило
 * й ввело штрихкод»). Камера працює невидимо за екраном програми: екран не ховається, нічого не відкривається,
 * світить лише ліхтарик — він показує, куди дивиться камера. Зчитаний код одразу йде в рядок пошуку.
 */
export async function startHiddenScan(): Promise<CameraScan> {
  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning')
  let permission = (await BarcodeScanner.checkPermissions()).camera
  if (permission !== 'granted' && permission !== 'limited') permission = (await BarcodeScanner.requestPermissions()).camera
  if (permission !== 'granted' && permission !== 'limited') throw new CameraDenied('Немає дозволу на камеру')

  let finished = false
  let finish: (code: string | null) => void = () => undefined
  const done = new Promise<string | null>(resolve => { finish = resolve })
  let listener: { remove: () => Promise<void> } | null = null
  const end = (code: string | null) => {
    if (finished) return
    finished = true
    void listener?.remove().catch(() => undefined)
    void BarcodeScanner.disableTorch().catch(() => undefined)
    void BarcodeScanner.stopScan().catch(() => undefined)
    finish(code)
  }
  try {
    listener = await BarcodeScanner.addListener('barcodesScanned', event => {
      const code = firstCode(event.barcodes)
      if (code) end(code)
    })
    await BarcodeScanner.startScan({ formats: nativeFormats() as never })
    // Ліхтарик — необовʼязковий: немає його в телефоні — сканує й так.
    try { if ((await BarcodeScanner.isTorchAvailable()).available && !finished) await BarcodeScanner.enableTorch() } catch { /* optional */ }
  } catch (error) {
    end(null)
    throw error
  }
  return { done, cancel: () => end(null) }
}

/**
 * Одне сканування камерою всередині застосунку. done → код або null (скасовано). Після завершення камера зупинена,
 * екран програми знову видно — що б не сталося.
 */
export async function startCameraScan(doc: Document = document): Promise<CameraScan> {
  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning')
  let permission = (await BarcodeScanner.checkPermissions()).camera
  if (permission !== 'granted' && permission !== 'limited') permission = (await BarcodeScanner.requestPermissions()).camera
  if (permission !== 'granted' && permission !== 'limited') throw new CameraDenied('Немає дозволу на камеру')

  let finished = false
  let finish: (code: string | null) => void = () => undefined
  const done = new Promise<string | null>(resolve => { finish = resolve })
  let overlay: HTMLElement | null = null
  let listener: { remove: () => Promise<void> } | null = null
  const end = (code: string | null) => {
    if (finished) return
    finished = true
    doc.documentElement.classList.remove(NATIVE_SCAN_CLASS)
    overlay?.remove()
    void listener?.remove().catch(() => undefined)
    void BarcodeScanner.stopScan().catch(() => undefined)
    finish(code)
  }
  try {
    overlay = scanOverlay(doc, () => end(null))
    doc.body.append(overlay)
    doc.documentElement.classList.add(NATIVE_SCAN_CLASS)
    listener = await BarcodeScanner.addListener('barcodesScanned', event => {
      const code = firstCode(event.barcodes)
      if (code) end(code)
    })
    await BarcodeScanner.startScan({ formats: nativeFormats() as never })
  } catch (error) {
    end(null)
    throw error
  }
  return { done, cancel: () => end(null) }
}
