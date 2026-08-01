// Вибір чекового принтера станції (desktop-каса).
//
// Навіщо окремо від етикеткового: раніше чек ішов на «принтер за замовчуванням»,
// тож варто було Windows перемкнути default на етикетковий HL80 — і чек летів
// на нього, зависав і глушив чергу. Тепер обидва принтери адресуються явно й
// ніколи не перетинаються. Прив'язка до робочого місця, тому localStorage.

export interface ReceiptPrinterSettings {
  /** Порожньо — визначити автоматично за назвою при першому друці. */
  printerName: string
}

const STORAGE_KEY = 'forsage_receipt_printer_v1'
const RECEIPT_PRINTER_RE = /(?:^|[^0-9])(?:pos|xp)?[- _]?58(?:[^0-9]|$)|58\s*mm|58мм|receipt|чек/i

function isReceiptPrinterName(name: string): boolean {
  return RECEIPT_PRINTER_RE.test(name)
}

export const DEFAULT_RECEIPT_PRINTER_SETTINGS: ReceiptPrinterSettings = {
  printerName: '',
}

/** Впізнаємо чековий принтер за назвою (POS-58, 58мм, receipt тощо). */
export function pickReceiptPrinter(printers: Array<{ name: string; isDefault?: boolean }>): string | null {
  const byName = printers.find((p) => isReceiptPrinterName(p.name))
  if (byName) return byName.name

  // Немає POS-58 — не друкуємо взагалі. Навіть офісний default не є чековим.
  return null
}

export function loadReceiptPrinterSettings(): ReceiptPrinterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_RECEIPT_PRINTER_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ReceiptPrinterSettings>
    return {
      printerName: typeof parsed.printerName === 'string' && isReceiptPrinterName(parsed.printerName) ? parsed.printerName : '',
    }
  } catch {
    return { ...DEFAULT_RECEIPT_PRINTER_SETTINGS }
  }
}

export function saveReceiptPrinterSettings(settings: ReceiptPrinterSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage недоступний — налаштування просто не збережуться
  }
}

/**
 * Ім'я чекового принтера для цієї станції: збережене, інакше автовизначене
 * (і одразу збережене, щоб не шукати щоразу). null — desktop недоступний.
 */
export async function resolveReceiptPrinter(): Promise<string | null> {
  const desktopPrint = typeof window !== 'undefined' ? window.forsageDesktop?.print : undefined
  if (!desktopPrint) return null

  const settings = loadReceiptPrinterSettings()
  if (settings.printerName) return settings.printerName

  try {
    const printers = await desktopPrint.listPrinters()
    const found = pickReceiptPrinter(printers)
    if (found) saveReceiptPrinterSettings({ ...settings, printerName: found })
    return found
  } catch {
    return null
  }
}
