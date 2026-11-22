/**
 * Накладна з телефона (етап 8 плану замовлень, 22.11.2026).
 * Телефон фотографує накладну, помічник розпізнає рядки, людина їх перевіряє й надсилає на касу командою
 * `invoice.draft`. Каса нічого не проводить і не створює карток: рядки лягають у «вхідні», і людина на касі
 * відкриває їх звичайною чернеткою приходу (те саме зіставлення з картками й підсвічування, що й у фото на касі).
 * Ціни тут у гривнях, як у розпізнаванні.
 */
export interface PhoneInvoiceRow {
  name: string; source_name?: string; sku?: string; barcode?: string; brand_name?: string; category_name?: string; unit?: string
  /** Відсутнє = не прочитано: каса підсвітить рядок, нічого не підставляємо. */
  qty?: number
  purchase_price_uah?: number
}
export interface PhoneInvoicePayload {
  supplier_name?: string | null
  invoice_number?: string | null
  notes?: string | null
  /** Хто надіслав з телефона — лише для примітки. */
  author?: string | null
  rows: PhoneInvoiceRow[]
}
export interface PhoneInvoiceEntry extends PhoneInvoicePayload { operation_id: string; received_at: string }

export const PHONE_INVOICE_MAX_ROWS = 300
export const PHONE_INVOICE_INBOX_LIMIT = 20
const INBOX_KEY = 'forsage:phone-invoices:v1'
export const PHONE_INVOICE_EVENT = 'forsage:phone-invoice'

const clean = (value: unknown, max: number) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max)
const optional = (value: unknown, max: number) => clean(value, max) || undefined

function readNumber(value: unknown, label: string, row: number, max: number, allowZero: boolean): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(String(value).trim().replace(/\s/g, '').replace(',', '.'))
  if (!Number.isFinite(number) || number < 0 || number > max || (!allowZero && number === 0)) throw new Error(`Рядок ${row}: перевірте поле «${label}».`)
  return number
}

/** Перевіряє накладну з телефона однаково у вебі й на касі. Нічого не вигадує: нечитане лишається порожнім. */
export function checkPhoneInvoice(raw: unknown): PhoneInvoicePayload {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('У накладній немає жодного рядка.')
  if (input.rows.length > PHONE_INVOICE_MAX_ROWS) throw new Error(`У накладній забагато рядків (до ${PHONE_INVOICE_MAX_ROWS}). Розбийте її на частини.`)
  const rows = input.rows.map((value, index): PhoneInvoiceRow => {
    const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const name = clean(item.name, 300)
    if (!name) throw new Error(`Рядок ${index + 1}: немає назви товару.`)
    const row: PhoneInvoiceRow = { name }
    const text: Array<[keyof PhoneInvoiceRow, number]> = [['source_name', 300], ['sku', 100], ['barcode', 64], ['brand_name', 120], ['category_name', 120], ['unit', 20]]
    for (const [key, max] of text) { const part = optional(item[key], max); if (part) (row as unknown as Record<string, unknown>)[key] = part }
    const qty = readNumber(item.qty, 'Кількість', index + 1, 1_000_000, false)
    const price = readNumber(item.purchase_price_uah, 'Закупка', index + 1, 10_000_000, true)
    if (qty !== undefined) row.qty = qty
    if (price !== undefined) row.purchase_price_uah = Math.round(price * 100) / 100
    return row
  })
  return {
    supplier_name: optional(input.supplier_name, 200) ?? null,
    invoice_number: optional(input.invoice_number, 60) ?? null,
    notes: optional(input.notes, 500) ?? null,
    author: optional(input.author, 120) ?? null,
    rows,
  }
}

/** Скільки рядків каса підсвітить: без кількості або без закупівельної ціни. */
export function phoneInvoiceGaps(rows: readonly PhoneInvoiceRow[]): number {
  return rows.filter(row => row.qty === undefined || row.purchase_price_uah === undefined).length
}

/** Сума накладної за прочитаними рядками, у копійках. */
export function phoneInvoiceTotal(rows: readonly PhoneInvoiceRow[]): number {
  return rows.reduce((sum, row) => sum + Math.round((row.qty ?? 0) * Math.round((row.purchase_price_uah ?? 0) * 100)), 0)
}

type Box = Pick<Storage, 'getItem' | 'setItem'>

/** «Вхідні» каси. Пошкоджений запис не ламає список — читаємо те, що ціле. */
export function listPhoneInvoices(storage: Box = localStorage): PhoneInvoiceEntry[] {
  try {
    const saved = JSON.parse(storage.getItem(INBOX_KEY) ?? '[]')
    if (!Array.isArray(saved)) return []
    return saved.filter((entry): entry is PhoneInvoiceEntry => Boolean(entry) && typeof entry.operation_id === 'string' && Array.isArray(entry.rows) && entry.rows.length > 0)
  } catch { return [] }
}

/**
 * Кладе накладну у «вхідні». Повтор тієї самої команди нічого не дублює. Переповнені «вхідні» — відмова:
 * тихо викинути чужу нерозібрану накладну не можна.
 */
export function storePhoneInvoice(operationId: string, raw: unknown, storage: Box = localStorage, now: Date = new Date()): { stored: boolean; rows: number } {
  const payload = checkPhoneInvoice(raw)
  const inbox = listPhoneInvoices(storage)
  if (inbox.some(entry => entry.operation_id === operationId)) return { stored: false, rows: payload.rows.length }
  if (inbox.length >= PHONE_INVOICE_INBOX_LIMIT) throw new Error(`На касі вже ${PHONE_INVOICE_INBOX_LIMIT} нерозібраних накладних з телефона. Розберіть або приберіть старі в «Поступленні товарів».`)
  storage.setItem(INBOX_KEY, JSON.stringify([...inbox, { ...payload, operation_id: operationId, received_at: now.toISOString() }]))
  return { stored: true, rows: payload.rows.length }
}

export function removePhoneInvoice(operationId: string, storage: Box = localStorage): void {
  storage.setItem(INBOX_KEY, JSON.stringify(listPhoneInvoices(storage).filter(entry => entry.operation_id !== operationId)))
}

/** Дія для звичайного шляху «накладна з розбору ШІ»: ті самі рядки, те саме зіставлення на касі. */
export function phoneInvoiceAction(entry: PhoneInvoiceEntry) {
  const from = entry.author ? `Накладна з телефона (${entry.author}).` : 'Накладна з телефона.'
  return {
    id: entry.operation_id, tool: 'create_products_bulk', title: 'Накладна з телефона', changes: [],
    payload: {
      products: entry.rows.map(row => ({ ...row })),
      supplier_name: entry.supplier_name ?? null,
      invoice_number: entry.invoice_number ?? '',
      notes: [from, entry.notes ?? '', 'Перевірте підсвічені рядки.'].filter(Boolean).join(' '),
    },
  }
}
