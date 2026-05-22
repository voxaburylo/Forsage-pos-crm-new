/**
 * Сервіс імпорту номенклатури з 1С (Excel/CSV)
 *
 * Підтримувані формати виводу з 1С:
 *   - "Вивести список" → Excel/CSV
 *   - "Ціновий аркуш" → Excel
 *   - Будь-який звіт з колонками: Артикул, Найменування, Група, Ціна, Штрихкод
 *
 * Типові заголовки 1С (авто-визначення):
 *   Артикул / Код / SKU                    → sku
 *   Найменування / Назва / Товар           → name
 *   Група / Папка / Категорія              → category
 *   Штрихкод / Barcode / EAN               → barcode
 *   Ціна / Ціна продажу / Роздрібна        → retail_price
 *   Закупівельна / Собівартість / Закупка  → purchase_price
 *   Залишок / Кількість / Qty              → qty
 *   Одиниця / Ед. вим. / Unit             → unit
 */

import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'

export interface OnecColumnMapping {
  sku?:            number
  name?:           number
  category?:       number
  barcode?:        number
  retail_price?:   number
  purchase_price?: number
  qty?:            number
  unit?:           number
}

export interface OnecImportRow {
  row:            number
  sku:            string
  name:           string
  category?:      string
  barcode?:       string
  retail_price:   number   // копійки
  purchase_price: number   // копійки
  qty:            number
  unit:           string
}

export interface OnecPreviewResult {
  rows:             OnecImportRow[]
  categories:       string[]           // унікальні назви груп
  detected_mapping: OnecColumnMapping
  total:            number
  header:           string[]
}

export interface OnecImportResult {
  created:    number
  updated:    number
  categories_created: number
  errors:     Array<{ row: number; sku: string; error: string }>
}

// ─── Авто-визначення колонок ──────────────────────────────────────────────────

export function detectOnecColumns(header: string[]): OnecColumnMapping {
  const map: OnecColumnMapping = {}
  header.forEach((h, i) => {
    const lh = h.toLowerCase().trim()
    if      (/^(артикул|sku|article|код товару|внутр.?код)/.test(lh))     map.sku            = i
    else if (/^(найменуван|назва|товар|номенклатура|наймен|name)/.test(lh)) map.name           = i
    else if (/^(груп|папк|категор|розділ|folder|group|parent)/.test(lh))  map.category       = i
    else if (/^(штрихкод|barcode|ean|код стб|upc)/.test(lh))              map.barcode        = i
    else if (/^(ціна прод|роздр|ціна рекоменд|price|retail)/.test(lh))   map.retail_price   = i
    else if (/^(закупів|собівартість|заготів|purchase|закупка|прих)/.test(lh)) map.purchase_price = i
    else if (/^(залишок|кількість|qty|кіл-ть|к-сть|quantity|stock)/.test(lh)) map.qty          = i
    else if (/^(один|ед\.?|unit|уп|пак)/.test(lh))                        map.unit           = i
    // Якщо не визначили sku — пробуємо "Код"
    else if (/^(код)/.test(lh) && map.sku === undefined)                  map.sku            = i
    // Ціна без уточнення — роздрібна
    else if (/^(ціна|price|вартість)/.test(lh) && map.retail_price === undefined) map.retail_price = i
  })
  return map
}

// ─── Парсинг CSV ─────────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const rows: string[][] = []

  for (const line of lines) {
    if (!line.trim()) continue
    // Визначаємо роздільник
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ','
    const cells = line.split(sep).map((c) => c.trim().replace(/^["']|["']$/g, ''))
    rows.push(cells)
  }
  return rows
}

function toKopecks(value: string): number {
  if (!value) return 0
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  const num = parseFloat(cleaned)
  if (isNaN(num)) return 0
  return Math.round(num * 100)
}

// ─── Preview (без запису в БД) ────────────────────────────────────────────────

export function previewOnecImport(
  text: string,
  mapping?: Partial<OnecColumnMapping>,
): OnecPreviewResult {
  const rawRows = parseCsv(text)
  if (rawRows.length < 2) {
    throw new Error('Файл порожній або містить лише заголовок')
  }

  const header      = rawRows[0]
  const autoMapping = detectOnecColumns(header)
  const col         = { ...autoMapping, ...mapping }

  const categories = new Set<string>()
  const rows: OnecImportRow[] = []

  for (let i = 1; i < rawRows.length; i++) {
    const cells = rawRows[i]
    if (!cells || cells.every((c) => !c.trim())) continue

    const sku  = col.sku  !== undefined ? cells[col.sku]?.trim()  ?? '' : ''
    const name = col.name !== undefined ? cells[col.name]?.trim() ?? '' : ''
    if (!name) continue  // пропускаємо порожні рядки

    const category = col.category !== undefined ? cells[col.category]?.trim() ?? '' : ''
    if (category) categories.add(category)

    rows.push({
      row:            i + 1,
      sku:            sku || `AUTO-${i}`,
      name,
      category:       category || undefined,
      barcode:        col.barcode        !== undefined ? cells[col.barcode]?.trim()        || undefined : undefined,
      retail_price:   col.retail_price   !== undefined ? toKopecks(cells[col.retail_price]  ?? '') : 0,
      purchase_price: col.purchase_price !== undefined ? toKopecks(cells[col.purchase_price] ?? '') : 0,
      qty:            col.qty            !== undefined ? parseFloat(cells[col.qty]?.replace(',', '.') ?? '0') || 0 : 0,
      unit:           col.unit           !== undefined ? cells[col.unit]?.trim() || 'шт' : 'шт',
    })
  }

  return {
    rows,
    categories:       Array.from(categories).sort(),
    detected_mapping: autoMapping,
    total:            rows.length,
    header,
  }
}

// ─── Фактичний імпорт в БД ───────────────────────────────────────────────────

export async function runOnecImport(
  tenantId: string,
  rows: OnecImportRow[],
  options: { mode: 'replace' | 'add'; updatePrices: boolean },
): Promise<OnecImportResult> {
  const result: OnecImportResult = { created: 0, updated: 0, categories_created: 0, errors: [] }

  // 1. Збираємо унікальні назви категорій і знаходимо/створюємо їх
  const categoryNames = [...new Set(rows.map((r) => r.category).filter(Boolean) as string[])]
  const categoryMap   = new Map<string, string>()  // name → id

  for (const catName of categoryNames) {
    // Пошук існуючої
    const { data: existing } = await db
      .from('categories')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('name', catName)
      .maybeSingle()

    if (existing) {
      categoryMap.set(catName, existing.id)
    } else {
      // Створюємо нову категорію
      const { data: created, error } = await db
        .from('categories')
        .insert({ tenant_id: tenantId, name: catName, sort_order: 0 })
        .select('id')
        .single()

      if (error) {
        logger.warn({ catName, error: error.message }, '1С імпорт: помилка створення категорії')
      } else if (created) {
        categoryMap.set(catName, created.id)
        result.categories_created++
      }
    }
  }

  // 2. Імпортуємо товари через upsert_product_import
  for (const row of rows) {
    try {
      const categoryId = row.category ? categoryMap.get(row.category) ?? null : null

      const { data, error } = await db.rpc('upsert_product_import', {
        p_tenant_id:      tenantId,
        p_sku:            row.sku,
        p_barcode:        row.barcode ?? null,
        p_name:           row.name,
        p_retail_price:   row.retail_price,
        p_purchase_price: row.purchase_price,
        p_qty_on_hand:    row.qty,
        p_unit:           row.unit,
        p_storage_bin:    null,
        p_mode:           options.mode,
      }) as any

      if (error) throw new Error(error.message)

      // upsert_product_import повертає масив — беремо перший елемент
      const record = Array.isArray(data) ? data[0] : data

      // Оновлюємо category_id окремо (RPC не знає про category_id)
      if (categoryId && record?.id) {
        await db.from('products')
          .update({ category_id: categoryId })
          .eq('id', record.id)
      }

      if (record?.is_new) result.created++
      else result.updated++

    } catch (err: any) {
      result.errors.push({ row: row.row, sku: row.sku, error: err.message })
      logger.warn({ row: row.row, sku: row.sku, error: err.message }, '1С імпорт: помилка рядка')
    }
  }

  logger.info(result, '1С імпорт завершено')
  return result
}
