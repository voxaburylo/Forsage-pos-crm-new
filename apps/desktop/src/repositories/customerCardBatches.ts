import { randomInt, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

/**
 * 23.11.2026 (план B2, слово власника): «генерація нових штрихкодів для клієнтів пачками» — для друкарні.
 * Пачка — стовпчик нових кодів карток. Кожен код перевіряється по картках клієнтів, штрихкодах товарів
 * (основних і додаткових) і по раніше виданих пачках. Видані коди запам'ятовуються як «вільні картки»:
 * вдруге не видаються, а коли таку картку вперше сканують на касі — програма пропонує прив'язати її до клієнта.
 * Формат обирається при генерації (рішення власника): 13 цифр з окремим початком або 10 цифр, як старі картки.
 * Зберігається в базі головного ПК (app_meta) — схема бази не змінюється.
 */
export type CardFormat = 'ean13' | 'digits10'
export type CardBatch = { id: string; created_at: string; created_by: string | null; format: CardFormat; codes: string[] }
export type CardBatchSummary = { id: string; created_at: string; format: CardFormat; count: number; linked: number }

const KEY_PREFIX = 'customer-card-batch:v1:'
export const CARD_BATCH_MAX = 5000
/** Скільки вільних карток зберігаємо загалом — щоб пачки не розросталися без кінця. */
export const CARD_CODES_TOTAL_MAX = 100_000
/**
 * Початок «29» — діапазон EAN для внутрішнього обігу (20–29). Власні штрихкоди товарів починаються на «200»,
 * тож картки з товарами не перетинаються вже за початком; перевірка по базі однаково виконується.
 */
export const CARD_EAN_PREFIX = '29'
/** 10 цифр: початок «77», а не «0» — щоб код не був схожий на номер телефону. */
export const CARD_DIGITS10_PREFIX = '77'

export function ean13CheckDigit(first12: string): string {
  if (!/^\d{12}$/.test(first12)) throw new Error('Для контрольної цифри потрібно 12 цифр')
  let sum = 0
  for (let index = 0; index < 12; index++) sum += Number(first12[index]) * (index % 2 === 0 ? 1 : 3)
  return String((10 - (sum % 10)) % 10)
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12]
}

type Random = (maxExclusive: number) => number
const digits = (length: number, random: Random) => Array.from({ length }, () => String(random(10))).join('')

export function makeCardCode(format: CardFormat, random: Random = randomInt): string {
  if (format === 'ean13') {
    const body = CARD_EAN_PREFIX + digits(10, random)
    return body + ean13CheckDigit(body)
  }
  return CARD_DIGITS10_PREFIX + digits(8, random)
}

function readBatches(db: LocalDatabase): CardBatch[] {
  const rows = db.prepare("SELECT value_json FROM app_meta WHERE key LIKE ? ORDER BY updated_at ASC, key ASC").all(KEY_PREFIX + '%') as Array<{ value_json: string }>
  const batches: CardBatch[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value_json) as Partial<CardBatch>
      if (typeof parsed.id !== 'string' || !Array.isArray(parsed.codes)) continue
      batches.push({
        id: parsed.id, created_at: String(parsed.created_at ?? ''), created_by: typeof parsed.created_by === 'string' ? parsed.created_by : null,
        format: parsed.format === 'digits10' ? 'digits10' : 'ean13',
        codes: parsed.codes.filter((code): code is string => typeof code === 'string' && /^\d{8,14}$/.test(code)),
      })
    } catch { /* зіпсований запис пачки не ламає решту */ }
  }
  return batches
}

/** Чи зайнятий код: картка клієнта (і видаленого теж), штрихкод товару — основний чи додатковий. */
function takenInDatabase(db: LocalDatabase, code: string, tenantId: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM customers WHERE tenant_id = ? AND card_barcode = ? LIMIT 1').get(tenantId, code)
    ?? db.prepare('SELECT 1 FROM products WHERE tenant_id = ? AND barcode = ? LIMIT 1').get(tenantId, code)
    ?? db.prepare('SELECT 1 FROM product_barcodes WHERE tenant_id = ? AND barcode = ? LIMIT 1').get(tenantId, code),
  )
}

export function generateCardBatch(
  db: LocalDatabase,
  input: { count: unknown; format: unknown; createdBy?: string | null },
  options: { random?: Random; now?: () => Date; tenantId?: string } = {},
): CardBatch {
  const count = Number(input.count)
  if (!Number.isSafeInteger(count) || count < 1 || count > CARD_BATCH_MAX) throw new Error(`Кількість карток — від 1 до ${CARD_BATCH_MAX}`)
  if (input.format !== 'ean13' && input.format !== 'digits10') throw new Error('Оберіть формат карток: 13 цифр або 10 цифр')
  const format: CardFormat = input.format
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID
  const random = options.random ?? randomInt
  const issued = new Set(readBatches(db).flatMap(batch => batch.codes))
  if (issued.size + count > CARD_CODES_TOTAL_MAX) throw new Error(`Видано вже ${issued.size} вільних карток. Більше ${CARD_CODES_TOTAL_MAX} програма не зберігає.`)
  const codes: string[] = []
  const fresh = new Set<string>()
  // Запас спроб: у просторі з мільйонів кодів збіги рідкісні; якщо їх забагато — щось не так, краще зупинитись.
  let attempts = count * 20 + 1000
  while (codes.length < count) {
    if (attempts-- <= 0) throw new Error('Не вдалося підібрати вільні коди. Оберіть інший формат або меншу кількість.')
    const code = makeCardCode(format, random)
    if (fresh.has(code) || issued.has(code) || takenInDatabase(db, code, tenantId)) continue
    fresh.add(code)
    codes.push(code)
  }
  const batch: CardBatch = { id: randomUUID(), created_at: (options.now?.() ?? new Date()).toISOString(), created_by: input.createdBy ?? null, format, codes }
  db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run(KEY_PREFIX + batch.id, JSON.stringify(batch), batch.created_at)
  return batch
}

function linkedCodes(db: LocalDatabase, tenantId: string): Set<string> {
  const rows = db.prepare('SELECT card_barcode FROM customers WHERE tenant_id = ? AND deleted_at IS NULL AND card_barcode IS NOT NULL').all(tenantId) as Array<{ card_barcode: string }>
  return new Set(rows.map(row => String(row.card_barcode).replace(/\s/g, '')))
}

/** Список пачок: дата, скільки видано, скільки вже прив'язано до клієнтів. Найновіші зверху. */
export function listCardBatches(db: LocalDatabase, tenantId = DEFAULT_TENANT_ID): CardBatchSummary[] {
  const linked = linkedCodes(db, tenantId)
  return readBatches(db)
    .map(batch => ({ id: batch.id, created_at: batch.created_at, format: batch.format, count: batch.codes.length, linked: batch.codes.filter(code => linked.has(code)).length }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function cardBatchCodes(db: LocalDatabase, id: unknown): string[] {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Некоректна пачка карток')
  const batch = readBatches(db).find(item => item.id === id)
  if (!batch) throw new Error('Пачку карток не знайдено')
  return batch.codes
}

/** Каса: відсканували код, якого немає ні в клієнтів, ні в товарів — чи це вільна картка з виданої пачки. */
export function isFreeCard(db: LocalDatabase, code: unknown, tenantId = DEFAULT_TENANT_ID): boolean {
  const normalized = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{8,14}$/.test(normalized)) return false
  if (!readBatches(db).some(batch => batch.codes.includes(normalized))) return false
  return !db.prepare('SELECT 1 FROM customers WHERE tenant_id = ? AND deleted_at IS NULL AND card_barcode = ? LIMIT 1').get(tenantId, normalized)
}
