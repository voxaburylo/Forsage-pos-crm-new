// Налаштування прямого TSPL-друку етикеток (desktop-каса).
// Зберігаються в localStorage — принтер прив'язаний до конкретного робочого
// місця, а не до акаунта, тому серверні налаштування тут не потрібні.

export interface TsplLabelPrintSettings {
  enabled: boolean
  printerName: string
  /** Зазор між етикетками на рулоні, мм. */
  gapMm: number
  /** Щільність нагріву 0..15. */
  density: number
  /** Розвернути друк на 180°, якщо етикетки виходять догори ногами. */
  rotate180: boolean
}

const STORAGE_KEY = 'forsage_label_tspl_v1'

export const DEFAULT_TSPL_SETTINGS: TsplLabelPrintSettings = {
  // У desktop-касі друкуємо напряму на термопринтер за замовчуванням.
  // Через драйвер етикетки часто виходять з пустою другою етикеткою.
  enabled: true,
  printerName: '',
  gapMm: 2,
  density: 8,
  rotate180: false,
}

const RECEIPT_PRINTER_RE = /(?:^|[^0-9])(?:pos|xp)?[- _]?58(?:[^0-9]|$)|58\s*mm|58мм|receipt|чек/i
const LABEL_PRINTER_RE = /hl[- _]?80|hilabel|label|tspl|3\s*inch|80\s*mm|80мм|(?:^|[^0-9])(?:pos|xp)?[- _]?80(?:[^0-9]|$)/i

export function isReceiptPrinterName(name: string): boolean {
  return RECEIPT_PRINTER_RE.test(name)
}

export function isLabelPrinterName(name: string): boolean {
  return LABEL_PRINTER_RE.test(name) && !isReceiptPrinterName(name)
}

function isValidSavedLabelPrinter(name: string): boolean {
  return name.trim().length > 0 && !isReceiptPrinterName(name)
}

/** Впізнаємо принтер етикеток за назвою (HL80, HiLabel, Xprinter, 80мм тощо). */
export function pickLabelPrinter(printers: Array<{ name: string }>): string | null {
  const match = printers.find((p) => isLabelPrinterName(p.name))
  return match ? match.name : null
}

export function loadTsplSettings(): TsplLabelPrintSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_TSPL_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<TsplLabelPrintSettings>
    return {
      enabled: parsed.enabled !== false,
      printerName: typeof parsed.printerName === 'string' && isValidSavedLabelPrinter(parsed.printerName) ? parsed.printerName : '',
      gapMm: Number.isFinite(Number(parsed.gapMm)) ? Math.max(0, Math.min(10, Number(parsed.gapMm))) : 2,
      density: Number.isFinite(Number(parsed.density)) ? Math.max(0, Math.min(15, Math.round(Number(parsed.density)))) : 8,
      rotate180: parsed.rotate180 === true,
    }
  } catch {
    return { ...DEFAULT_TSPL_SETTINGS }
  }
}

export function saveTsplSettings(settings: TsplLabelPrintSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage недоступний — налаштування просто не збережуться
  }
}
