import { CAMERA_FORMATS } from './cameraScan'

/**
 * Рідний сканер телефона в застосунку для Android та iOS (27.11.2026, слово власника: «у вебі погано працює сканер
 * з камери»). У застосунку «курок» сканера відкриває сканер самого телефона (Google ML Kit): він сам тримає фокус,
 * наближає дрібний код і читає при слабкому світлі. Зчитаний код іде тим самим шляхом, що й з USB-сканера.
 * У браузері цей файл нічого не робить — там лишається камера через браузер.
 */
type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string }
const capacitor = (): CapacitorGlobal | undefined => (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor

export function isNativeApp(): boolean {
  try { return capacitor()?.isNativePlatform?.() === true } catch { return false }
}

/** Назви форматів у нашій програмі («ean_13») → назви в сканері телефона («EAN_13»). */
export function nativeFormats(formats: readonly string[] = CAMERA_FORMATS): string[] {
  return formats.map(format => format.toUpperCase())
}

/** Перший непорожній код із відповіді сканера. */
export function firstCode(barcodes: ReadonlyArray<{ rawValue?: string | null; displayValue?: string | null }> | null | undefined): string | null {
  for (const barcode of barcodes ?? []) {
    const value = String(barcode?.rawValue || barcode?.displayValue || '').trim()
    if (value) return value
  }
  return null
}

/** Людина закрила сканер, не зчитавши код, — це не помилка. */
export const isScanCancel = (error: unknown) => /cancel/i.test(String((error as { message?: unknown })?.message ?? error ?? ''))

export class ScannerNotReady extends Error {}

/**
 * Одне сканування рідним сканером. Повертає код або null (закрили без коду).
 * На Android сканер — окремий модуль Google: на новому телефоні його треба один раз довантажити (кілька секунд).
 */
export async function nativeScanOnce(): Promise<string | null> {
  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning')
  if (capacitor()?.getPlatform?.() === 'android') {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
    if (!available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule()
      throw new ScannerNotReady('Сканер телефона довантажується — це один раз і займає кілька секунд. Натисніть сканер ще раз.')
    }
  }
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: nativeFormats() as never, autoZoom: true })
    return firstCode(barcodes)
  } catch (error) {
    if (isScanCancel(error)) return null
    throw error
  }
}
