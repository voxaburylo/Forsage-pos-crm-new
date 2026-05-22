import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { createSupplyInvoice } from './supplierService.js'
import type {
  ParsedItem,
  ParseImportInput,
  PreviewImportInput,
  ConfirmImportInput
} from '../validators/importSchema.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

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

async function matchProduct(sku: string, name: string): Promise<{
  matched:       boolean
  product_id:    string | null
  match_quality: 'exact' | 'fuzzy' | 'new'
  warnings:      string[]
}> {
  const warnings: string[] = []

  if (sku) {
    const { data } = await db.from('products').select('id, sku, name')
      .is('deleted_at', null).eq('sku', normalizeArticle(sku)).maybeSingle()
    if (data) return { matched: true, product_id: data.id, match_quality: 'exact', warnings: [] }
  }

  if (name) {
    const { data } = await db.from('products').select('id, sku, name')
      .is('deleted_at', null).eq('name', name.trim()).maybeSingle()
    if (data) {
      warnings.push('Знайдено за назвою (артикул не збігається)')
      return { matched: true, product_id: data.id, match_quality: 'fuzzy', warnings }
    }
  }

  if (name) {
    const searchTerm = name.trim().slice(0, 60)
    const { data: results } = await db.from('products').select('id, sku, name')
      .is('deleted_at', null).ilike('name', '%' + searchTerm + '%').limit(5)

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

export async function parseClipboardText(input: ParseImportInput): Promise<ParseResult> {
  const rawRows = parseRows(input.text)
  const items: ParsedItem[] = []

  for (const row of rawRows) {
    const match = await matchProduct(row.sku, row.name)
    items.push({
      row:           row.row,
      sku:           row.sku,
      name:          row.name,
      qty:           row.qty,
      price:         row.price,
      matched:       match.matched,
      product_id:    match.product_id,
      match_quality: match.match_quality,
      warnings:      match.warnings,
    })
  }

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

export async function previewImport(input: PreviewImportInput): Promise<PreviewResult> {
  const { text, mapping } = input

  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').filter((l) => l.trim().length > 0)

  if (lines.length === 0) {
    throw new AppError('PARSE_ERROR', 'Текст порожній', 400)
  }

  const first = lines[0]
  const tabCount       = first.split('\t').length
  const semicolonCount = first.split(';').length
  const commaCount     = first.split(',').length
  let sep = '\t'
  if (semicolonCount >= tabCount && semicolonCount >= commaCount) sep = ';'
  else if (commaCount >= tabCount && commaCount >= semicolonCount) sep = ','

  let startLine = 0
  // Перевірка наявності заголовка
  if (lines.length > 0) {
    const parts = lines[0].split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ''))
    let looksLikeHeader = false

    if (mapping.qty !== null && mapping.qty !== undefined && parts[mapping.qty]) {
      const val = parseFloat(parts[mapping.qty].replace(/,/g, '.').replace(/[^\d.]/g, ''))
      if (isNaN(val)) looksLikeHeader = true
    }
    if (mapping.price !== null && mapping.price !== undefined && parts[mapping.price]) {
      const val = parseFloat(parts[mapping.price].replace(/,/g, '.').replace(/[^\d.]/g, ''))
      if (isNaN(val)) looksLikeHeader = true
    }
    if (mapping.name !== null && mapping.name !== undefined && parts[mapping.name]) {
      if (/назв|товар|наймен|name|product|description/i.test(parts[mapping.name])) {
        looksLikeHeader = true
      }
    }

    if (looksLikeHeader) {
      startLine = 1
    }
  }

  interface TemporaryItem {
    row:          number
    sku:          string
    name:         string
    qty:          number
    price:        number
    retail_price: number | null
    barcode:      string | null
    storage_bin:  string | null
  }

  const temporaryItems: TemporaryItem[] = []
  const conflicts: PreviewConflict[] = []
  const seenSkus = new Set<string>()

  for (let i = startLine; i < lines.length; i++) {
    const parts = lines[i].split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ''))
    const rowNum = i + 1

    // Отримуємо назву
    const name = mapping.name !== null && mapping.name !== undefined ? (parts[mapping.name] ?? '').trim() : ''
    if (!name) {
      conflicts.push({ row: rowNum, reason: 'Відсутня назва товару' })
      continue
    }

    // Отримуємо ціну
    const rawPrice = mapping.price !== null && mapping.price !== undefined ? parts[mapping.price] ?? '' : ''
    const priceHryvnia = parseFloat(rawPrice.replace(/,/g, '.').replace(/[^\d.]/g, ''))
    if (isNaN(priceHryvnia) || priceHryvnia < 0) {
      conflicts.push({ row: rowNum, name, reason: `Некоректна ціна закупівлі: "${rawPrice}"` })
      continue
    }
    const price = Math.round(priceHryvnia * 100)

    // Отримуємо кількість
    let qty = 1
    if (mapping.qty !== null && mapping.qty !== undefined) {
      const rawQty = parts[mapping.qty] ?? ''
      const parsedQty = parseFloat(rawQty.replace(/,/g, '.').replace(/[^\d.]/g, ''))
      if (isNaN(parsedQty) || parsedQty < 0) {
        conflicts.push({ row: rowNum, name, reason: `Некоректна кількість: "${rawQty}"` })
        continue
      }
      qty = parsedQty
    }

    // Отримуємо роздрібну ціну
    let retail_price: number | null = null
    if (mapping.retail_price !== null && mapping.retail_price !== undefined) {
      const rawRetail = parts[mapping.retail_price] ?? ''
      if (rawRetail) {
        const parsedRetail = parseFloat(rawRetail.replace(/,/g, '.').replace(/[^\d.]/g, ''))
        if (!isNaN(parsedRetail) && parsedRetail >= 0) {
          retail_price = Math.round(parsedRetail * 100)
        }
      }
    }

    // Отримуємо артикул
    const sku = mapping.sku !== null && mapping.sku !== undefined ? (parts[mapping.sku] ?? '').trim() : ''

    // Перевірка дублікатів SKU в межах файлу
    if (sku) {
      const normSku = normalizeArticle(sku)
      if (seenSkus.has(normSku)) {
        conflicts.push({ row: rowNum, sku, name, reason: 'Дублікат артикулу в імпортованому файлі' })
        continue
      }
      seenSkus.add(normSku)
    }

    // Отримуємо штрихкод та комірку
    const barcode = mapping.barcode !== null && mapping.barcode !== undefined ? (parts[mapping.barcode] ?? '').trim() : null
    const storage_bin = mapping.storage_bin !== null && mapping.storage_bin !== undefined ? (parts[mapping.storage_bin] ?? '').trim() : null

    temporaryItems.push({
      row: rowNum,
      sku,
      name,
      qty,
      price,
      retail_price,
      barcode,
      storage_bin,
    })
  }

  // Завантажуємо продукти з бази для пошуку збігів
  const skus = temporaryItems.map(i => normalizeArticle(i.sku)).filter(Boolean)
  const barcodes = temporaryItems.map(i => i.barcode).filter(Boolean) as string[]
  const names = temporaryItems.map(i => i.name.trim()).filter(Boolean)

  let dbProducts: any[] = []
  if (skus.length > 0 || barcodes.length > 0 || names.length > 0) {
    const promises = []
    if (skus.length > 0) {
      promises.push(
        db.from('products')
          .select('id, sku, name, purchase_price, retail_price, qty_on_hand, barcode, storage_bin')
          .is('deleted_at', null)
          .in('sku', skus)
      )
    }
    if (barcodes.length > 0) {
      promises.push(
        db.from('products')
          .select('id, sku, name, purchase_price, retail_price, qty_on_hand, barcode, storage_bin')
          .is('deleted_at', null)
          .in('barcode', barcodes)
      )
    }
    if (names.length > 0) {
      promises.push(
        db.from('products')
          .select('id, sku, name, purchase_price, retail_price, qty_on_hand, barcode, storage_bin')
          .is('deleted_at', null)
          .in('name', names)
      )
    }

    const results = await Promise.all(promises)
    for (const r of results) {
      if (r.data) {
        dbProducts = dbProducts.concat(r.data)
      }
    }
  }

  const dbProductsMap = new Map<string, any>()
  for (const p of dbProducts) {
    dbProductsMap.set(p.id, p)
  }
  const dbProductsList = Array.from(dbProductsMap.values())

  const items: ParsedItem[] = []

  for (const item of temporaryItems) {
    let matchedProduct: any = null
    let matchQuality: 'exact' | 'fuzzy' | 'new' = 'new'
    const warnings: string[] = []

    // 1. Точний збіг по SKU
    if (item.sku) {
      const norm = normalizeArticle(item.sku)
      matchedProduct = dbProductsList.find(p => p.sku === norm)
      if (matchedProduct) {
        matchQuality = 'exact'
      }
    }

    // 2. Точний збіг по штрихкоду (якщо не збіглося по SKU)
    if (!matchedProduct && item.barcode) {
      matchedProduct = dbProductsList.find(p => p.barcode === item.barcode)
      if (matchedProduct) {
        matchQuality = 'exact'
        warnings.push('Збіг за штрихкодом')
      }
    }

    // 3. Точний збіг по назві
    if (!matchedProduct && item.name) {
      const trimmedName = item.name.trim().toLowerCase()
      matchedProduct = dbProductsList.find(p => p.name.trim().toLowerCase() === trimmedName)
      if (matchedProduct) {
        matchQuality = 'fuzzy'
        warnings.push('Знайдено за назвою (артикул/штрихкод не збігається)')
      }
    }

    // 4. Левенштейн (fuzzy) пошук для невеликих файлів
    if (!matchedProduct && item.name && temporaryItems.length < 100) {
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
        warnings.push(`Схожий товар в базі: "${bestProduct.name}"`)
      }
    }

    if (matchedProduct) {
      items.push({
        row:           item.row,
        sku:           item.sku || matchedProduct.sku,
        name:          item.name,
        qty:           item.qty,
        price:         item.price,
        retail_price:  item.retail_price || null,
        barcode:       item.barcode || matchedProduct.barcode || null,
        storage_bin:   item.storage_bin || matchedProduct.storage_bin || null,
        matched:       true,
        product_id:    matchedProduct.id,
        match_quality: matchQuality,
        warnings,
        // Додаткові поля для порівняння в прев'ю
        old_price:        matchedProduct.purchase_price,
        old_qty:          matchedProduct.qty_on_hand,
        old_retail_price: matchedProduct.retail_price,
      } as any)
    } else {
      items.push({
        row:           item.row,
        sku:           item.sku,
        name:          item.name,
        qty:           item.qty,
        price:         item.price,
        retail_price:  item.retail_price || null,
        barcode:       item.barcode || null,
        storage_bin:   item.storage_bin || null,
        matched:       false,
        product_id:    null,
        match_quality: 'new',
        warnings:      ['Новий товар (не знайдено в базі даних)'],
      })
    }
  }

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

async function getCalculatedRetailPrice(purchasePrice: number): Promise<number> {
  let markupPct = 30
  const { data: settings } = await db.from('shop_settings').select('markup_rules').single()
  const rules = (settings as any)?.markup_rules as Array<{ minPrice: number; maxPrice: number; markupPct: number }> | undefined
  if (rules) {
    const rule = rules.find((r) => purchasePrice >= r.minPrice && purchasePrice < r.maxPrice)
    if (rule) markupPct = rule.markupPct
  }
  return Math.round(purchasePrice * (1 + markupPct / 100))
}

export async function confirmImport(input: ConfirmImportInput, userId: string) {
  // ЯКЩО ВКАЗАНО ПОСТАЧАЛЬНИКА -> Створюємо прихідну накладну (стара поведінка)
  if (input.supplier_id) {
    const invoiceItems = []

    for (const item of input.items) {
      let productId = item.product_id

      if (!productId && input.create_missing) {
        const calculatedRetailPrice = await getCalculatedRetailPrice(item.price)
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
            tenant_id:      TENANT_ID,
            barcode:        item.barcode || null,
            storage_bin:    item.storage_bin || null,
          })
          .select('id').single()

        if (createError || !newProduct) {
          throw new AppError('DB_ERROR', 'Помилка створення товару "' + item.name + '": ' + createError?.message, 500)
        }
        productId = newProduct.id
      }

      if (!productId) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Товар "' + item.name + '" (рядок ' + item.row + ') не знайдено. Пропустіть або увімкніть "Створити нові товари".',
          400,
        )
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
    })
  }

  // ЯКЩО ПОСТАЧАЛЬНИКА НЕ ВКАЗАНО -> Прямий імпорт у каталог товарів через RPC
  const productIds = input.items.map((i) => i.product_id).filter(Boolean) as string[]
  const skus = input.items.map((i) => normalizeArticle(i.sku)).filter(Boolean)
  const barcodes = input.items.map((i) => i.barcode).filter(Boolean) as string[]

  let existingProducts: any[] = []
  if (productIds.length > 0 || skus.length > 0 || barcodes.length > 0) {
    const promises = []
    if (productIds.length > 0) {
      promises.push(db.from('products').select('id, sku, barcode, retail_price').in('id', productIds))
    }
    if (skus.length > 0) {
      promises.push(db.from('products').select('id, sku, barcode, retail_price').in('sku', skus))
    }
    if (barcodes.length > 0) {
      promises.push(db.from('products').select('id, sku, barcode, retail_price').in('barcode', barcodes))
    }
    const results = await Promise.all(promises)
    for (const r of results) {
      if (r.data) {
        existingProducts = existingProducts.concat(r.data)
      }
    }
  }

  const existingMap = new Map<string, any>()
  for (const p of existingProducts) {
    existingMap.set(p.id, p)
    if (p.sku) existingMap.set(p.sku, p)
    if (p.barcode) existingMap.set(p.barcode, p)
  }

  const resultsSummary = { created: 0, updated: 0, errors: 0 }

  for (const item of input.items) {
    let hasMatch = false
    let matchedProduct = null

    if (item.product_id) {
      matchedProduct = existingMap.get(item.product_id)
    }
    if (!matchedProduct && item.sku) {
      matchedProduct = existingMap.get(normalizeArticle(item.sku))
    }
    if (!matchedProduct && item.barcode) {
      matchedProduct = existingMap.get(item.barcode)
    }

    if (matchedProduct) {
      hasMatch = true
    }

    if (!hasMatch && !input.create_missing) {
      resultsSummary.errors++
      continue
    }

    let retailPriceToUse = item.retail_price ?? 0

    if (hasMatch) {
      if (!input.update_retail) {
        retailPriceToUse = matchedProduct.retail_price ?? 0
      } else if (!retailPriceToUse) {
        retailPriceToUse = await getCalculatedRetailPrice(item.price)
      }
    } else {
      if (!retailPriceToUse) {
        retailPriceToUse = await getCalculatedRetailPrice(item.price)
      }
    }

    const skuToUse = item.sku ? normalizeArticle(item.sku) : 'IMP-' + Date.now() + '-' + item.row

    const { data, error } = await db.rpc('upsert_product_import', {
      p_tenant_id:      TENANT_ID,
      p_sku:            skuToUse,
      p_barcode:        item.barcode ?? null,
      p_name:           item.name,
      p_retail_price:   retailPriceToUse,
      p_purchase_price: item.price,
      p_qty_on_hand:    item.qty,
      p_unit:           'шт',
      p_storage_bin:    item.storage_bin ?? null,
      p_mode:           input.mode ?? 'replace',
    })

    if (error || !data) {
      resultsSummary.errors++
    } else {
      const res = data as any
      if (res.is_new) {
        resultsSummary.created++
      } else {
        resultsSummary.updated++
      }
    }
  }

  return resultsSummary
}
