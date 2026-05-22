import { db } from '../db/supabase.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { createReadStream, promises as fs } from 'fs'
import readline from 'readline'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

interface ColMap {
  sku?: number
  name?: number
  qty?: number
  price?: number
}

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

function parseCsvLine(line: string, sep: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"' || char === "'") {
      inQuotes = !inQuotes
    } else if (char === sep && !inQuotes) {
      result.push(current.trim().replace(/^["']|["']$/g, ''))
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim().replace(/^["']|["']$/g, ''))
  return result
}

function detectSeparator(firstLine: string): string {
  const tabCount = firstLine.split('\t').length
  const semicolonCount = firstLine.split(';').length
  const commaCount = firstLine.split(',').length
  let sep = '\t'
  if (semicolonCount >= tabCount && semicolonCount >= commaCount) sep = ';'
  else if (commaCount >= tabCount && commaCount >= semicolonCount) sep = ','
  return sep
}

export async function processImport(
  _jobId: string,
  payload: {
    importId: string
    tempPath: string
    supplierId: string | null
    updateRetail: boolean
    mode: 'replace' | 'add'
  }
) {
  const { importId, tempPath, updateRetail, mode } = payload
  let totalRows = 0
  let processedRows = 0
  const errorsLog: Array<{ row: number; error: string; raw?: string }> = []

  try {
    // 1. Оновлюємо статус на processing
    await db
      .from('supplier_price_imports')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', importId)

    // 2. Рахуємо загальну кількість рядків у файлі (для прогрес-бару)
    const countStream = createReadStream(tempPath)
    const countRl = readline.createInterface({
      input: countStream,
      crlfDelay: Infinity,
    })

    let hasLines = false
    for await (const line of countRl) {
      if (line.trim()) {
        totalRows++
        hasLines = true
      }
    }
    countRl.close()

    if (!hasLines || totalRows <= 1) {
      throw new Error('Файл порожній або містить лише заголовок')
    }

    // Заголовок віднімаємо від загальної кількості
    totalRows = totalRows - 1

    await db
      .from('supplier_price_imports')
      .update({ total_rows: totalRows, updated_at: new Date().toISOString() })
      .eq('id', importId)

    // 3. Зчитуємо правила націнки
    const { data: settings } = await db.from('shop_settings').select('markup_rules').single()
    const markupRules = (settings as any)?.markup_rules as Array<{ minPrice: number; maxPrice: number; markupPct: number }> | undefined

    function calculateRetailPrice(purchasePrice: number): number {
      let markupPct = 30
      if (markupRules) {
        const rule = markupRules.find((r) => purchasePrice >= r.minPrice && purchasePrice < r.maxPrice)
        if (rule) markupPct = rule.markupPct
      }
      return Math.round(purchasePrice * (1 + markupPct / 100))
    }

    // 4. Починаємо парсинг та імпорт чанками
    const parseStream = createReadStream(tempPath)
    const rl = readline.createInterface({
      input: parseStream,
      crlfDelay: Infinity,
    })

    let sep = '\t'
    let colMap: ColMap = {}
    let lineNum = 0
    let chunk: Array<{
      sku: string
      name: string
      price: number
      qty: number
      rowNum: number
    }> = []

    for await (const line of rl) {
      lineNum++
      const trimmed = line.trim()
      if (!trimmed) continue

      // Визначаємо сепаратор і колонки на першому рядку
      if (lineNum === 1) {
        sep = detectSeparator(trimmed)
        colMap = guessColumns(trimmed, sep)
        if (colMap.name === undefined) {
          throw new Error('Не вдалося знайти заголовок з назвою товару. Стовпці мають містити назву (Name/Найменування)')
        }
        continue
      }

      // Парсимо звичайний рядок
      try {
        const parts = parseCsvLine(line, sep)
        const name = (colMap.name !== undefined ? parts[colMap.name] ?? '' : '').trim()
        if (!name) {
          errorsLog.push({ row: lineNum, error: 'Відсутня назва товару', raw: line })
          continue
        }

        const rawSku = colMap.sku !== undefined ? parts[colMap.sku] ?? '' : ''
        const sku = rawSku.trim() ? normalizeArticle(rawSku) : 'IMP-' + Date.now() + '-' + lineNum

        const rawPrice = colMap.price !== undefined ? parts[colMap.price] ?? '' : ''
        const priceHryvnia = parseFloat(rawPrice.replace(/,/g, '.').replace(/[^\d.]/g, ''))
        if (isNaN(priceHryvnia) || priceHryvnia < 0) {
          errorsLog.push({ row: lineNum, error: `Невірна ціна: "${rawPrice}"`, raw: line })
          continue
        }
        const price = Math.round(priceHryvnia * 100)

        let qty = 0
        if (colMap.qty !== undefined) {
          const rawQty = parts[colMap.qty] ?? ''
          const parsedQty = parseFloat(rawQty.replace(/,/g, '.').replace(/[^\d.]/g, ''))
          if (!isNaN(parsedQty) && parsedQty >= 0) {
            qty = parsedQty
          }
        }

        chunk.push({ sku, name, price, qty, rowNum: lineNum })

        // Якщо назбирали 1000 рядків, робимо імпорт
        if (chunk.length >= 1000) {
          await processChunk(chunk, updateRetail, mode, calculateRetailPrice)
          processedRows += chunk.length
          chunk = []

          // Оновлюємо прогрес у БД
          await db
            .from('supplier_price_imports')
            .update({
              processed_rows: processedRows,
              errors_log: errorsLog,
              updated_at: new Date().toISOString(),
            })
            .eq('id', importId)
        }
      } catch (err: any) {
        errorsLog.push({ row: lineNum, error: err.message || 'Помилка обробки рядка', raw: line })
      }
    }

    rl.close()

    // Обробляємо залишок чанку
    if (chunk.length > 0) {
      await processChunk(chunk, updateRetail, mode, calculateRetailPrice)
      processedRows += chunk.length
    }

    // 5. Оновлюємо статус на completed
    await db
      .from('supplier_price_imports')
      .update({
        status: 'completed',
        processed_rows: processedRows,
        errors_log: errorsLog,
        updated_at: new Date().toISOString(),
      })
      .eq('id', importId)

  } catch (err: any) {
    // Оновлюємо статус на failed при помилці
    await db
      .from('supplier_price_imports')
      .update({
        status: 'failed',
        errors_log: [...errorsLog, { row: 0, error: err.message || 'Критична помилка імпорту' }],
        updated_at: new Date().toISOString(),
      })
      .eq('id', importId)

    throw err
  } finally {
    // Очищаємо тимчасовий файл
    try {
      await fs.unlink(tempPath)
    } catch {}
  }
}

async function processChunk(
  items: Array<{ sku: string; name: string; price: number; qty: number; rowNum: number }>,
  updateRetail: boolean,
  mode: 'replace' | 'add',
  calculateRetailPrice: (purchasePrice: number) => number
) {
  // Вибираємо унікальні SKU для цього чанку
  const skus = Array.from(new Set(items.map((i) => i.sku)))

  // Отримуємо існуючі товари, щоб дізнатися qty_on_hand та retail_price
  const { data: existingProducts } = await db
    .from('products')
    .select('sku, id, qty_on_hand, retail_price')
    .is('deleted_at', null)
    .in('sku', skus)

  const existingMap = new Map<string, { id: string; qty_on_hand: number; retail_price: number }>()
  if (existingProducts) {
    existingProducts.forEach((p) => {
      existingMap.set(p.sku, {
        id: p.id,
        qty_on_hand: Number(p.qty_on_hand),
        retail_price: p.retail_price,
      })
    })
  }

  // Викликаємо RPC upsert_product_import для кожного товару в чанку
  for (const item of items) {
    const existing = existingMap.get(item.sku)

    let retailPrice: number
    if (existing) {
      retailPrice = updateRetail ? calculateRetailPrice(item.price) : existing.retail_price
    } else {
      retailPrice = calculateRetailPrice(item.price)
    }

    const qty = item.qty

    await db.rpc('upsert_product_import', {
      p_tenant_id:      TENANT_ID,
      p_sku:            item.sku,
      p_barcode:        null,
      p_name:           item.name,
      p_retail_price:   retailPrice,
      p_purchase_price: item.price,
      p_qty_on_hand:    qty,
      p_unit:           'шт',
      p_storage_bin:    null,
      p_mode:           mode,
    })
  }
}
