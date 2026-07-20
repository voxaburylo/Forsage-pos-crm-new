import { randomUUID } from 'node:crypto'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { applyMarkup, roundingFromSettings, type MarkupRule } from '../lib/markup.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { createSupplyInvoice } from './supplierService.js'
import type {
  ParsedItem,
  ParseImportInput,
  PreviewImportInput,
  ConfirmImportInput
} from '../validators/importSchema.js'

// No fallback TENANT_ID

function normalizeForMatch(s: string): string {
  return s.replace(/[\s\-\/\.\_\(\)\[\]]/g, '').toLowerCase().replace(/^0+/, '')
}

function levenshtein(a: string, b: string): number {
  const alen = a.length, blen = b.length
  const matrix: number[][] = []
  for (let i = 0; i <= alen; i++) {
    matrix[i] = [i]
    for (let j = 1; j <= blen; j++) {
      matrix[i][j] = i === 0
        ? j
        : Math.min(
            matrix[i - 1][j] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
          )
    }
  }
  return matrix[alen][blen]
}

interface RawRow { row: number; sku: string; name: string; qty: number; price: number }
interface ColMap  { sku?: number; name?: number; qty?: number; price?: number }

function guessColumns(header: string, sep: string): ColMap {
  const parts = header.split(sep).map((s) => s.trim().toLowerCase())
  const map: ColMap = {}
  parts.forEach((p, i) => {
    if (/артикул|sku|код|article/i.test(p))                         map.sku   = i
    else if (/назв|товар|наймен|name|product|description/i.test(p)) map.name  = i
    else if (/кільк|к-сть|qty|кол-во|quantity/i.test(p))           map.qty   = i
    else if (/цін|price|cost|вартість|purchase/i.test(p))           map.price = i
  })
  return map
}

function parseRows(text: string): RawRow[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').filter((l) => l.trim().length > 0)

  if (lines.length === 0) throw new AppError('PARSE_ERROR', 'Текст порожній', 400)

  const first = lines[0]
  const tabCount       = first.split('\t').length
  const semicolonCount = first.split(';').length
  const commaCount     = first.split(',').length
  let sep = '\t'
  if (semicolonCount >= tabCount && semicolonCount >= commaCount) sep = ';'
  else if (commaCount >= tabCount && commaCount >= semicolonCount) sep = ','

  let colMap: ColMap = {}
  let startLine = 0

  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const guessed = guessColumns(lines[i], sep)
    if (guessed.name !== undefined && (guessed.qty !== undefined || guessed.price !== undefined)) {
      colMap = guessed
      startLine = i + 1
      break
    }
  }

  if (colMap.name === undefined) {
    throw new AppError(
      'PARSE_ERROR',
      'Не вдалось визначити колонки. Перевірте що є заголовки: Артикул, Назва, Кількість, Ціна',
      400,
    )
  }

  const results: RawRow[] = []
  for (let i = startLine; i < lines.length; i++) {
    const parts = lines[i].split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ''))
    const name = (colMap.name !== undefined ? parts[colMap.name] ?? '' : '').trim()
    if (!name) continue

    const rawQty   = colMap.qty   !== undefined ? parts[colMap.qty]   ?? '' : ''
    const rawPrice = colMap.price !== undefined ? parts[colMap.price] ?? '' : ''

    const qty = parseFloat(rawQty.replace(/,/g, '.').replace(/[^\d.]/g, ''))
    if (isNaN(qty) || qty <= 0) continue

    const priceHryvnia = parseFloat(rawPrice.replace(/,/g, '.').replace(/[^\d.]/g, ''))
    if (isNaN(priceHryvnia) || priceHryvnia < 0) continue

    const sku = (colMap.sku !== undefined ? parts[colMap.sku] ?? '' : '').trim()
    results.push({ row: i + 1, sku, name, qty, price: Math.round(priceHryvnia * 100) })
  }

  if (results.length === 0) {
    throw new AppError('PARSE_ERROR', 'Не знайдено жодного рядка з товарами. Перевірте формат.', 400)
  }
  return results
}

interface MatchedProduct { id: string; sku: string; name: string }

export async function matchProduct(sku: string, name: string, tenantId: string): Promise<{
  matched:       boolean
  product_id:    string | null
  match_quality: 'exact' | 'fuzzy' | 'new'
  warnings:      string[]
}> {
  const warnings: string[] = []

  if (sku) {
    const { data } = await db.from('products').select('id, sku, name')
      .eq('tenant_id', tenantId).is('deleted_at', null).eq('sku', normalizeArticle(sku)).maybeSingle()
    if (data) return { matched: true, product_id: data.id, match_quality: 'exact', warnings: [] }
  }

  if (name) {
    const { data } = await db.from('products').select('id, sku, name')
      .eq('tenant_id', tenantId).is('deleted_at', null).eq('name', name.trim()).maybeSingle()
    if (data) {
      warnings.push('Знайдено за назвою (артикул не збігається)')
      return { matched: true, product_id: data.id, match_quality: 'fuzzy', warnings }
    }
  }

  if (name) {
    const searchTerm = name.trim().slice(0, 60)
    const { data: results } = await db.from('products').select('id, sku, name')
      .eq('tenant_id', tenantId).is('deleted_at', null).ilike('name', '%' + searchTerm + '%').limit(5)

    if (results && results.length > 0) {
      const normName = normalizeForMatch(name)
      let best: MatchedProduct | null = null
      let bestDist = Infinity

      for (const p of results) {
        const dist = levenshtein(normName, normalizeForMatch(p.name))
        const similarity = 1 - dist / Math.max(normName.length, normalizeForMatch(p.name).length)
        if (similarity > 0.4 && dist < bestDist) { bestDist = dist; best = p }
      }

      if (best) {
        warnings.push('Схожий товар: "' + best.name + '"')
        return { matched: true, product_id: best.id, match_quality: 'fuzzy', warnings }
      }
    }
  }

  return { matched: false, product_id: null, match_quality: 'new', warnings: ['Товар не знайдено в базі'] }
}

export interface ParseResult {
  supplier_id:   string | null | undefined
  items:         ParsedItem[]
  total_items:   number
  matched_count: number
  new_count:     number
}

export async function parseClipboardText(input: ParseImportInput, tenantId: string): Promise<ParseResult> {
  const rawRows = parseRows(input.text)
  
  const tempItems: TemporaryItem[] = rawRows.map(r => ({
    row: r.row,
    sku: r.sku,
    name: r.name,
    qty: r.qty,
    price: r.price,
    retail_price: null,
    barcode: null,
    storage_bin: null,
    category_name: null,
  }))

  const dbProductsList = await fetchDbProducts(tempItems, tenantId)
  const bySku = new Map<string, any>()
  const byBarcode = new Map<string, any>()
  const byName = new Map<string, any>()
  for (const p of dbProductsList) {
    if (p.sku) bySku.set(String(p.sku), p)
    if (p.barcode) byBarcode.set(String(p.barcode), p)
    if (p.name) byName.set(String(p.name).trim().toLowerCase(), p)
  }
  const items = tempItems.map(item => matchPreviewProduct(item, dbProductsList, { bySku, byBarcode, byName }, tempItems.length))

  return {
    supplier_id:   input.supplier_id,
    items,
    total_items:   items.length,
    matched_count: items.filter((i) => i.matched).length,
    new_count:     items.filter((i) => !i.matched).length,
  }
}

// ===================== НОВІ ФУНКЦІЇ ДЛЯ ЕТАПУ 10 =====================

export interface PreviewConflict {
  row: number
  sku?: string
  name?: string
  qty?: string
  price?: string
  reason: string
}

export interface PreviewResult {
  items: ParsedItem[]
  conflicts: PreviewConflict[]
  summary: {
    toCreate: number
    toUpdate: number
    conflicts: number
  }
}

// Decomposed helpers for previewImport
interface TemporaryItem {
  row:          number
  sku:          string
  name:         string
  qty:          number
  price:        number
  retail_price: number | null
  barcode:      string | null
  storage_bin:  string | null
  category_name: string | null
  warnings?:    string[]      // напр. «ціну не розпізнано — оновіть після імпорту»
  price_review?: boolean      // true, якщо ціну не вдалося розпізнати (товар «під питанням»)
}

function detectDelimiter(firstLine: string): string {
  const tabCount       = firstLine.split("\t").length
  const semicolonCount = firstLine.split(";").length
  const commaCount     = firstLine.split(",").length
  let sep = "\t"
  if (semicolonCount >= tabCount && semicolonCount >= commaCount) sep = ";"
  else if (commaCount >= tabCount && commaCount >= semicolonCount) sep = ","
  return sep
}

function normalizeImportBarcode(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  const compact = raw.replace(/\s+/g, '').replace(',', '.')

  // Excel часто перетворює штрихкоди на 2000998788926.0 або 2.000998788926E+12.
  // EAN/Code128 коди магазину значно менші за MAX_SAFE_INTEGER, тому безпечно
  // повертаємо їх назад у звичайний рядок без дробової частини.
  if (/^\d+\.0+$/.test(compact)) {
    return compact.replace(/\.0+$/, '')
  }
  if (/^\d+(?:\.\d+)?e\+\d+$/i.test(compact)) {
    const numeric = Number(compact)
    if (Number.isSafeInteger(numeric)) return String(numeric)
  }

  return compact
}

function checkHasHeader(firstLine: string, sep: string, mapping: any): boolean {
  const parts = firstLine.split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ""))
  let looksLikeHeader = false

  if (mapping.qty !== null && mapping.qty !== undefined && parts[mapping.qty]) {
    const val = parseFloat(parts[mapping.qty].replace(/,/g, ".").replace(/[^\d.]/g, ""))
    if (isNaN(val)) looksLikeHeader = true
  }
  if (mapping.price !== null && mapping.price !== undefined && parts[mapping.price]) {
    const val = parseFloat(parts[mapping.price].replace(/,/g, ".").replace(/[^\d.]/g, ""))
    if (isNaN(val)) looksLikeHeader = true
  }
  if (mapping.name !== null && mapping.name !== undefined && parts[mapping.name]) {
    if (/назв|товар|наймен|name|product|description/i.test(parts[mapping.name])) {
      looksLikeHeader = true
    }
  }
  return looksLikeHeader
}

function parseImportLines(
  lines: string[],
  sep: string,
  startLine: number,
  mapping: any
): { temporaryItems: TemporaryItem[]; conflicts: PreviewConflict[] } {
  const temporaryItems: TemporaryItem[] = []
  const conflicts: PreviewConflict[] = []
  const seenSkus = new Set<string>()
  const seenBarcodes = new Set<string>()

  for (let i = startLine; i < lines.length; i++) {
    const parts = lines[i].split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ""))
    const rowNum = i + 1

    // Отримуємо назву (єдина справді обов'язкова умова — без назви товар не має сенсу)
    const name = mapping.name !== null && mapping.name !== undefined ? (parts[mapping.name] ?? "").trim() : ""
    if (!name) {
      conflicts.push({ row: rowNum, reason: "Відсутня назва товару" })
      continue
    }

    const itemWarnings: string[] = []

    // Ціна закупівлі: якщо порожня/не число — НЕ пропускаємо рядок, а ставимо 0
    // і позначаємо товар «під питанням» (потрібно оновити ціну після імпорту).
    const rawPrice = mapping.price !== null && mapping.price !== undefined ? (parts[mapping.price] ?? "") : ""
    const priceHryvnia = parseFloat(rawPrice.replace(/,/g, ".").replace(/[^\d.]/g, ""))
    let price = 0
    let priceReview = false
    if (isNaN(priceHryvnia) || priceHryvnia < 0) {
      price = 0
      priceReview = true
      itemWarnings.push(
        rawPrice.trim()
          ? 'Ціну не розпізнано ("' + rawPrice.trim() + '") — додано з ціною 0, потрібно оновити'
          : 'Ціна відсутня — додано з ціною 0, потрібно оновити'
      )
    } else {
      price = Math.round(priceHryvnia * 100)
    }

    // Кількість (залишок): порожня/не число — просто 0, без пропуску рядка
    let qty = 1 // якщо колонку залишку не призначено
    if (mapping.qty !== null && mapping.qty !== undefined) {
      const rawQty = (parts[mapping.qty] ?? "").trim()
      if (!rawQty) {
        qty = 0
      } else {
        const parsedQty = parseFloat(rawQty.replace(/,/g, ".").replace(/[^\d.]/g, ""))
        qty = (isNaN(parsedQty) || parsedQty < 0) ? 0 : parsedQty
      }
    }

    // Отримуємо роздрібну ціну
    let retail_price: number | null = null
    if (mapping.retail_price !== null && mapping.retail_price !== undefined) {
      const rawRetail = parts[mapping.retail_price] ?? ""
      if (rawRetail) {
        const parsedRetail = parseFloat(rawRetail.replace(/,/g, ".").replace(/[^\d.]/g, ""))
        if (!isNaN(parsedRetail) && parsedRetail >= 0) {
          retail_price = Math.round(parsedRetail * 100)
        }
      }
    }

    // Отримуємо артикул
    const sku = mapping.sku !== null && mapping.sku !== undefined ? (parts[mapping.sku] ?? "").trim() : ""

    // Перевірка дублікатів SKU в межах файлу
    if (sku) {
      const normSku = normalizeArticle(sku)
      if (seenSkus.has(normSku)) {
        conflicts.push({ row: rowNum, sku, name, reason: "Дублікат артикулу в імпортованому файлі" })
        continue
      }
      seenSkus.add(normSku)
    }

    const barcode = mapping.barcode !== null && mapping.barcode !== undefined
      ? normalizeImportBarcode(parts[mapping.barcode] ?? "")
      : null
    if (barcode) {
      if (seenBarcodes.has(barcode)) {
        conflicts.push({ row: rowNum, sku, name, reason: "Дублікат штрихкоду в імпортованому файлі" })
        continue
      }
      seenBarcodes.add(barcode)
    }
    const storage_bin = mapping.storage_bin !== null && mapping.storage_bin !== undefined ? (parts[mapping.storage_bin] ?? "").trim() : null
    const category_name = mapping.category !== null && mapping.category !== undefined
      ? (parts[mapping.category] ?? "").trim().slice(0, 200) || null
      : null

    temporaryItems.push({
      row: rowNum,
      sku,
      name,
      qty,
      price,
      retail_price,
      barcode,
      storage_bin,
      category_name,
      warnings: itemWarnings.length ? itemWarnings : undefined,
      price_review: priceReview || undefined,
    })
  }

  return { temporaryItems, conflicts }
}

async function fetchDbProducts(temporaryItems: TemporaryItem[], tenantId: string): Promise<any[]> {
  // Унікалізуємо значення — щоб не гнати дублі у запити
  const skus = [...new Set(temporaryItems.map(i => normalizeArticle(i.sku)).filter(Boolean))]
  const barcodes = [...new Set(temporaryItems.map(i => normalizeImportBarcode(i.barcode)).filter(Boolean) as string[])]
  const names = [...new Set(temporaryItems.map(i => i.name.trim()).filter(Boolean))]

  const SELECT = "id, sku, name, purchase_price, retail_price, qty_on_hand, barcode, additional_barcodes, storage_bin"
  const dbProductsMap = new Map<string, any>()
  const barcodeAliases = new Map<string, string>()

  // PostgREST кладе .in(...) у query-рядок URL. На великих списках URL перевищує
  // ліміт і запит падає. Кирилиця (назви) в URL кодується ВТРИЧІ довше, тому для
  // назв порція значно менша. Помилка окремої порції не валить увесь імпорт —
  // просто частина збігів по цьому полю не врахується (артикул/штрихкод головні).
  async function queryIn(field: string, values: string[], chunkSize: number, concurrency: number) {
    const slices: string[][] = []
    for (let i = 0; i < values.length; i += chunkSize) slices.push(values.slice(i, i + chunkSize))
    let failed = 0
    let cursor = 0
    async function worker() {
      while (cursor < slices.length) {
        const slice = slices[cursor++]
        try {
          const { data, error } = await db
            .from("products")
            .select(SELECT)
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .in(field, slice)
          if (error) throw new Error(error.message)
          if (data) for (const p of data) dbProductsMap.set(p.id, p)
        } catch (e: any) {
          failed++
        }
      }
    }
    const workers: Promise<void>[] = []
    for (let k = 0; k < Math.min(concurrency, slices.length); k++) workers.push(worker())
    await Promise.all(workers)
    if (failed > 0) {
      logger.warn({ field, failed }, "[import] частину порцій пошуку товарів не вдалося виконати")
    }
  }

  if (skus.length > 0) await queryIn("sku", skus, 200, 6)          // ASCII-артикули
  if (barcodes.length > 0) await queryIn("barcode", barcodes, 200, 6)
  if (barcodes.length > 0) {
    const productIds = new Set<string>()
    const slices: string[][] = []
    for (let i = 0; i < barcodes.length; i += 200) slices.push(barcodes.slice(i, i + 200))

    for (const slice of slices) {
      try {
        const { data, error } = await db
          .from("product_barcodes")
          .select("product_id, barcode")
          .eq("tenant_id", tenantId)
          .in("barcode", slice)
        if (error) throw new Error(error.message)
        for (const row of data ?? []) {
          const normalized = normalizeImportBarcode(row.barcode)
          if (!normalized || !row.product_id) continue
          barcodeAliases.set(normalized, row.product_id)
          productIds.add(row.product_id)
        }
      } catch (e: any) {
        logger.warn({ err: e?.message }, "[import] пошук додаткових штрихкодів не вдався")
      }
    }

    if (productIds.size > 0) await queryIn("id", [...productIds], 200, 6)
  }
  if (names.length > 0) await queryIn("name", names, 25, 8)        // кирилиця → дрібніше

  for (const [barcode, productId] of barcodeAliases.entries()) {
    const product = dbProductsMap.get(productId)
    if (!product) continue
    const aliases = Array.isArray(product._import_barcode_aliases) ? product._import_barcode_aliases : []
    aliases.push(barcode)
    product._import_barcode_aliases = aliases
  }

  return Array.from(dbProductsMap.values())
}

function matchPreviewProduct(
  item: TemporaryItem,
  dbProductsList: any[],
  idx: { bySku: Map<string, any>; byBarcode: Map<string, any>; byName: Map<string, any> },
  totalItemsCount: number,
): ParsedItem {
  let matchedProduct: any = null
  let matchQuality: 'exact' | 'fuzzy' | 'new' = 'new'
  const warnings: string[] = [...(item.warnings ?? [])] // напр. «оновіть ціну»

  // 1. Точний збіг по SKU
  if (item.sku) {
    const norm = normalizeArticle(item.sku)
    matchedProduct = idx.bySku.get(norm)
    if (matchedProduct) {
      matchQuality = 'exact'
    }
  }

  // 2. Точний збіг по штрихкоду
  if (!matchedProduct && item.barcode) {
    matchedProduct = idx.byBarcode.get(item.barcode)
    if (matchedProduct) {
      matchQuality = 'exact'
      warnings.push("Збіг за штрихкодом")
    }
  }

  // 3. Точний збіг по назві
  if (!matchedProduct && item.name) {
    const trimmedName = item.name.trim().toLowerCase()
    matchedProduct = idx.byName.get(trimmedName)
    if (matchedProduct) {
      matchQuality = 'fuzzy'
      warnings.push("Знайдено за назвою (артикул/штрихкод не збігається)")
    }
  }

  // 4. Левенштейн (fuzzy) пошук для невеликих файлів
  if (!matchedProduct && item.name && totalItemsCount < 100) {
    const normName = normalizeForMatch(item.name)
    let bestDist = Infinity
    let bestProduct: any = null

    for (const p of dbProductsList) {
      const dist = levenshtein(normName, normalizeForMatch(p.name))
      const similarity = 1 - dist / Math.max(normName.length, normalizeForMatch(p.name).length)
      if (similarity > 0.5 && dist < bestDist) {
        bestDist = dist
        bestProduct = p
      }
    }

    if (bestProduct) {
      matchedProduct = bestProduct
      matchQuality = 'fuzzy'
      warnings.push("Схожий товар в базі: \"" + bestProduct.name + "\"")
    }
  }

  if (matchedProduct) {
    return {
      row:           item.row,
      sku:           item.sku || matchedProduct.sku,
      name:          item.name,
      qty:           item.qty,
      price:         item.price,
      retail_price:  item.retail_price || null,
      barcode:       item.barcode || matchedProduct.barcode || null,
      storage_bin:   item.storage_bin || matchedProduct.storage_bin || null,
      category_name: item.category_name,
      matched:       true,
      product_id:    matchedProduct.id,
      match_quality: matchQuality,
      warnings,
      price_review:  item.price_review || false,
      old_price:        matchedProduct.purchase_price,
      old_qty:          matchedProduct.qty_on_hand,
      old_retail_price: matchedProduct.retail_price,
    } as any
  } else {
    return {
      row:           item.row,
      sku:           item.sku,
      name:          item.name,
      qty:           item.qty,
      price:         item.price,
      retail_price:  item.retail_price || null,
      barcode:       item.barcode || null,
      storage_bin:   item.storage_bin || null,
      category_name: item.category_name,
      matched:       false,
      product_id:    null,
      match_quality: 'new',
      warnings:      [...warnings, "Новий товар (не знайдено в базі даних)"],
      price_review:  item.price_review || false,
    } as any
  }
}

export async function previewImport(input: PreviewImportInput, tenantId: string): Promise<PreviewResult> {
  const { text, mapping } = input

  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .split("\n").filter((l) => l.trim().length > 0)

  if (lines.length === 0) {
    throw new AppError("PARSE_ERROR", "Текст порожній", 400)
  }

  const sep = detectDelimiter(lines[0])
  const startLine = checkHasHeader(lines[0], sep, mapping) ? 1 : 0

  const { temporaryItems, conflicts } = parseImportLines(lines, sep, startLine, mapping)
  const dbProductsList = await fetchDbProducts(temporaryItems, tenantId)

  // Індекси для O(1) пошуку (інакше на «всіх товарах» — квадратична складність)
  const bySku = new Map<string, any>()
  const byBarcode = new Map<string, any>()
  const byName = new Map<string, any>()
  for (const p of dbProductsList) {
    if (p.sku) bySku.set(normalizeArticle(String(p.sku)), p)
    if (p.barcode) byBarcode.set(normalizeImportBarcode(String(p.barcode)) ?? String(p.barcode), p)
    if (Array.isArray(p.additional_barcodes)) {
      for (const barcode of p.additional_barcodes) {
        const normalized = normalizeImportBarcode(String(barcode))
        if (normalized) byBarcode.set(normalized, p)
      }
    }
    if (Array.isArray(p._import_barcode_aliases)) {
      for (const barcode of p._import_barcode_aliases) {
        const normalized = normalizeImportBarcode(String(barcode))
        if (normalized) byBarcode.set(normalized, p)
      }
    }
    if (p.name) byName.set(String(p.name).trim().toLowerCase(), p)
  }
  const idx = { bySku, byBarcode, byName }

  const items = temporaryItems.map(item => matchPreviewProduct(item, dbProductsList, idx, temporaryItems.length))

  const toCreate = items.filter(i => !i.matched).length
  const toUpdate = items.filter(i => i.matched).length

  return {
    items,
    conflicts,
    summary: {
      toCreate,
      toUpdate,
      conflicts: conflicts.length
    }
  }
}
async function getCalculatedRetailPrice(purchasePrice: number, tenantId: string): Promise<number> {
  const { data: settings } = await db.from('shop_settings').select('markup_rules, price_rounding_enabled, price_rounding_step, price_rounding_dir').eq('tenant_id', tenantId).single()
  const rules = (settings as any)?.markup_rules as MarkupRule[] | undefined
  return applyMarkup(purchasePrice, rules, 30, roundingFromSettings(settings))
}

function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
}

async function resolveImportCategories(items: ParsedItem[], tenantId: string): Promise<Map<string, string>> {
  const requested = new Map<string, string>()
  for (const item of items) {
    const name = item.category_name?.trim().replace(/\s+/g, ' ')
    if (name) requested.set(normalizeCategoryName(name), name)
  }
  if (requested.size === 0) return new Map()

  const { data: existing, error: fetchError } = await db
    .from('categories')
    .select('id, name')
    .eq('tenant_id', tenantId)
  if (fetchError) throw new AppError('DB_ERROR', 'Не вдалося завантажити категорії: ' + fetchError.message, 500)

  const categoryMap = new Map<string, string>()
  for (const category of existing ?? []) {
    categoryMap.set(normalizeCategoryName(category.name), category.id)
  }

  const missing = [...requested.entries()]
    .filter(([key]) => !categoryMap.has(key))
    .map(([, name]) => ({ tenant_id: tenantId, name, sort_order: 0 }))

  if (missing.length > 0) {
    const { data: created, error: createError } = await db
      .from('categories')
      .insert(missing)
      .select('id, name')
    if (createError) {
      throw new AppError('DB_ERROR', 'Не вдалося створити категорії з файлу: ' + createError.message, 500)
    }
    for (const category of created ?? []) {
      categoryMap.set(normalizeCategoryName(category.name), category.id)
    }
  }

  return categoryMap
}

async function syncImportedBarcodeIndex(tenantId: string, items: Array<{ product_id?: string | null; sku?: string | null; barcode?: string | null }>): Promise<void> {
  const barcodeItems = items
    .map((item) => ({
      product_id: item.product_id ?? null,
      sku: item.sku ? normalizeArticle(String(item.sku)) : null,
      barcode: normalizeImportBarcode(item.barcode ?? '') ?? null,
    }))
    .filter((item) => item.barcode)
  if (barcodeItems.length === 0) return

  const productIds = [...new Set(barcodeItems.map((item) => item.product_id).filter((id): id is string => Boolean(id)))]
  const skus = [...new Set(barcodeItems.map((item) => item.sku).filter((sku): sku is string => Boolean(sku)))]
  const barcodes = [...new Set(barcodeItems.map((item) => item.barcode).filter((barcode): barcode is string => Boolean(barcode)))]
  const productRows = new Map<string, any>()
  const collect = (rows: any[] | null) => { for (const row of rows ?? []) productRows.set(row.id, row) }

  if (productIds.length > 0) {
    const { data, error } = await db.from('products').select('id,sku,barcode').eq('tenant_id', tenantId).in('id', productIds)
    if (error) throw error
    collect(data)
  }
  if (skus.length > 0) {
    const { data, error } = await db.from('products').select('id,sku,barcode').eq('tenant_id', tenantId).in('sku', skus)
    if (error) throw error
    collect(data)
  }
  if (barcodes.length > 0) {
    const { data, error } = await db.from('products').select('id,sku,barcode').eq('tenant_id', tenantId).in('barcode', barcodes)
    if (error) throw error
    collect(data)
  }

  const now = new Date().toISOString()
  const indexRows = [...productRows.values()]
    .map((product) => ({ product, barcode: normalizeImportBarcode(product.barcode ?? '') }))
    .filter((row) => row.barcode)
    .map((row) => ({
      id: randomUUID(),
      tenant_id: tenantId,
      product_id: row.product.id,
      barcode: row.barcode,
      barcode_type: 'ean13',
      is_primary: true,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }))
  if (indexRows.length === 0) return

  const existingByBarcode = new Map<string, string>()
  const uniqueIndexBarcodes = [...new Set(indexRows.map((row) => row.barcode).filter((barcode): barcode is string => Boolean(barcode)))]
  if (uniqueIndexBarcodes.length > 0) {
    const { data: existingIndexRows, error: existingIndexError } = await db
      .from('product_barcodes')
      .select('barcode,product_id')
      .eq('tenant_id', tenantId)
      .in('barcode', uniqueIndexBarcodes)
      .is('deleted_at', null)
    if (existingIndexError) throw existingIndexError
    for (const row of existingIndexRows ?? []) {
      if (row.barcode && row.product_id) existingByBarcode.set(row.barcode, row.product_id)
    }
  }

  const safeRowsByBarcode = new Map<string, typeof indexRows[number]>()
  for (const row of indexRows) {
    const barcode = row.barcode
    if (!barcode) continue
    const existingProductId = existingByBarcode.get(barcode)
    if (existingProductId && existingProductId !== row.product_id) {
      logger.warn({ barcode, productId: row.product_id, existingProductId }, '[import] штрихкод вже належить іншому товару, індекс не перезаписано')
      continue
    }
    const previous = safeRowsByBarcode.get(barcode)
    if (previous && previous.product_id !== row.product_id) {
      logger.warn({ barcode, productId: row.product_id, previousProductId: previous.product_id }, '[import] дубль штрихкоду в імпорті, індекс не перезаписано')
      continue
    }
    safeRowsByBarcode.set(barcode, row)
  }
  const safeIndexRows = [...safeRowsByBarcode.values()]
  if (safeIndexRows.length === 0) return

  const { error } = await db.from('product_barcodes').upsert(safeIndexRows, { onConflict: 'tenant_id,barcode' })
  if (error) throw error
}

export async function confirmImport(input: ConfirmImportInput, userId: string, tenantId: string) {
  const categoryMap = await resolveImportCategories(input.items, tenantId)
  const categoryIdFor = (item: ParsedItem) =>
    item.category_name ? categoryMap.get(normalizeCategoryName(item.category_name)) ?? null : null

  // ЯКЩО ВКАЗАНО ПОСТАЧАЛЬНИКА -> Створюємо прихідну накладну (стара поведінка)
  if (input.supplier_id) {
    const invoiceItems = []

    for (const item of input.items) {
      let productId = item.product_id

      let createdProduct = false
      if (!productId && input.create_missing) {
        const calculatedRetailPrice = await getCalculatedRetailPrice(item.price, tenantId)
        const newSku = item.sku ? normalizeArticle(item.sku) : 'IMP-' + Date.now() + '-' + item.row
        const { data: newProduct, error: createError } = await db
          .from('products')
          .insert({
            sku:            newSku,
            name:           item.name,
            unit:           'шт',
            purchase_price: item.price,
            retail_price:   item.retail_price ?? (input.update_retail ? calculatedRetailPrice : Math.round(item.price * 1.3)),
            qty_on_hand:    0,
            reorder_point:  0,
            is_active:      true,
            tenant_id:      tenantId,
            barcode:        item.barcode || null,
            storage_bin:    item.storage_bin || null,
            category_id:    categoryIdFor(item),
          })
          .select('id').single()

        if (createError || !newProduct) {
          throw new AppError('DB_ERROR', 'Помилка створення товару "' + item.name + '": ' + createError?.message, 500)
        }
        productId = newProduct.id
        createdProduct = true
      }

      if (!productId) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Товар "' + item.name + '" (рядок ' + item.row + ') не знайдено. Пропустіть або увімкніть "Створити нові товари".',
          400,
        )
      }

      const categoryId = categoryIdFor(item)
      if (!createdProduct) {
        const productPatch: Record<string, unknown> = {}
        if (item.name) productPatch.name = item.name
        if (item.barcode) productPatch.barcode = item.barcode
        if (item.storage_bin) productPatch.storage_bin = item.storage_bin
        if (categoryId) productPatch.category_id = categoryId
        if (Object.keys(productPatch).length > 0) {
          const { error: productPatchError } = await db
            .from('products')
            .update({ ...productPatch, updated_at: new Date().toISOString() })
            .eq('id', productId)
            .eq('tenant_id', tenantId)
          if (productPatchError) {
            throw new AppError('DB_ERROR', 'Не вдалося оновити товар з накладної "' + item.name + '": ' + productPatchError.message, 500)
          }
        }
      }

      if (item.barcode) {
        try {
          await syncImportedBarcodeIndex(tenantId, [{ product_id: productId, sku: item.sku, barcode: item.barcode }])
        } catch (indexError: any) {
          logger.warn({ err: indexError?.message, productId }, '[import] не вдалося оновити індекс штрихкоду для накладної')
        }
      }

      invoiceItems.push({
        product_id:     productId,
        qty:            item.qty,
        purchase_price: item.price,
        total:          Math.round(item.qty * item.price),
      })
    }

    return createSupplyInvoice(userId, {
      supplier_id:    input.supplier_id ?? undefined,
      invoice_number: input.invoice_number ?? undefined,
      notes:          input.notes ?? undefined,
      items:          invoiceItems,
    }, tenantId)
  }

  // ЯКЩО ПОСТАЧАЛЬНИКА НЕ ВКАЗАНО -> Прямий імпорт у каталог ПАКЕТНИМ RPC.
  // Раніше: окремий RPC + окремий запит налаштувань на КОЖЕН товар (9000 рядків
  // = десятки тисяч звернень -> 20-40 хв). Тепер: правила націнки кешуємо один
  // раз, а всі товари відправляємо порціями по 500 у серверну функцію
  // upsert_products_import_bulk (обробляє масив за один виклик).
  const now = Date.now()
  const { data: settings } = await db.from('shop_settings').select('markup_rules, price_rounding_enabled, price_rounding_step, price_rounding_dir').eq('tenant_id', tenantId).single()
  const rules = (settings as any)?.markup_rules as MarkupRule[] | undefined
  const rounding = roundingFromSettings(settings)
  const updateRetail = input.update_retail ?? true

  const payloadItems = input.items.map((i) => {
    const sku = i.sku ? normalizeArticle(i.sku) : 'IMP-' + now + '-' + i.row
    // роздрібну рахуємо локально (без запиту в БД на кожен рядок)
    let retail = i.retail_price ?? 0
    if (!retail) retail = applyMarkup(i.price, rules, 30, rounding)
    return {
      sku,
      product_id: i.product_id ?? null,
      barcode: i.barcode ?? null,
      name: i.name,
      retail_price: retail,
      purchase_price: i.price,
      qty_on_hand: i.qty,
      unit: 'шт',
      storage_bin: i.storage_bin ?? null,
      category_id: categoryIdFor(i),
    }
  })

  const summary = { created: 0, updated: 0, errors: 0 }
  const CHUNK = 500
  for (let i = 0; i < payloadItems.length; i += CHUNK) {
    const chunk = payloadItems.slice(i, i + CHUNK)
    const { data, error } = await db.rpc('upsert_products_import_bulk', {
      p_tenant_id:      tenantId,
      p_items:          chunk,
      p_mode:           input.mode ?? 'replace',
      p_update_retail:  updateRetail,
      p_create_missing: input.create_missing ?? false,
    })
    if (error || !data) {
      summary.errors += chunk.length
      logger.warn({ err: error?.message, from: i }, '[import] пакетна порція не вдалася')
    } else {
      const r = data as any
      summary.created += r.created ?? 0
      summary.updated += (r.updated ?? 0) + (r.restored ?? 0) // відновлені = оновлені для користувача
      summary.errors  += (r.errors ?? 0) + (r.skipped ?? 0)
      try {
        await syncImportedBarcodeIndex(tenantId, chunk)
      } catch (indexError: any) {
        logger.warn({ err: indexError?.message, from: i }, '[import] не вдалося оновити індекс штрихкодів')
      }
    }
  }

  return summary
}
