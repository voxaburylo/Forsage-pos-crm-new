import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { normalizeArticle } from '../validators/productValidator.js'
import { createReadStream, promises as fs } from 'fs'
import readline from 'readline'

interface ColMap {
  sku?: number
  name?: number
  qty?: number
  price?: number
  brand?: number
}

function guessColumns(header: string, sep: string): ColMap {
  const parts = header.split(sep).map((s) => s.trim().toLowerCase())
  const map: ColMap = {}
  parts.forEach((p, i) => {
    if (/артикул|sku|код|article/i.test(p))                         map.sku   = i
    else if (/назв|товар|наймен|номенклат|детал|запчаст|опис|позиц|наименован|name|product|description|item|title/i.test(p)) map.name  = i
    else if (/кільк|к-сть|qty|кол-во|quantity/i.test(p))           map.qty   = i
    else if (/цін|price|cost|вартість|purchase/i.test(p))           map.price = i
    else if (/бренд|виробн|brand|manufacturer|mfr/i.test(p))        map.brand = i
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
    warehouseName: string | null
  }
) {
  const { importId, tempPath, supplierId, mode, warehouseName } = payload
  let totalRows = 0
  let processedRows = 0
  const errorsLog: Array<{ row: number; error: string; raw?: string }> = []

  try {
    // Fetch import record to get its tenant_id
    const { data: importRecord } = await db
      .from('supplier_price_imports')
      .select('tenant_id')
      .eq('id', importId)
      .single()

    if (!importRecord) throw new Error('Запис імпорту не знайдено')
    const tenantId = importRecord.tenant_id

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

    // 2b. Якщо режим 'replace' і вказано постачальника, видаляємо старі записи перед імпортом
    if (mode === 'replace' && supplierId) {
      let query = db
        .from('supplier_price_items')
        .delete()
        .eq('supplier_id', supplierId)
        .eq('tenant_id', tenantId)
      
      if (warehouseName) {
        query = query.eq('warehouse_name', warehouseName)
      } else {
        query = query.is('warehouse_name', null)
      }

      const { error: delError } = await query
      if (delError) {
        throw new Error('Не вдалося видалити старі записи прайсу постачальника: ' + delError.message)
      }
    }

    // 3. Починаємо парсинг та імпорт чанками
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
      brand: string
      name: string
      price: number
      qty: number
      rowNum: number
    }> = []

    for await (const line of rl) {
      lineNum++
      const trimmed = line.trim()
      if (!trimmed) continue

      if (lineNum === 1) {
        sep = detectSeparator(trimmed)
        colMap = guessColumns(trimmed, sep)
        if (colMap.name === undefined) {
          throw new AppError(
            'IMPORT_NO_NAME_COLUMN',
            `Перший рядок файлу має бути ЗАГОЛОВКОМ зі стовпцями. Не знайдено стовпець із назвою товару — назвіть його «Назва» (або «Номенклатура», «Найменування», «Name»). Очікувані стовпці: Назва, Артикул, Ціна, Кількість.`,
            400,
          )
        }
        continue
      }

      try {
        const parts = parseCsvLine(line, sep)
        const name = (colMap.name !== undefined ? parts[colMap.name] ?? '' : '').trim()
        if (!name) {
          errorsLog.push({ row: lineNum, error: 'Відсутня назва товару', raw: line })
          continue
        }

        const rawSku = colMap.sku !== undefined ? parts[colMap.sku] ?? '' : ''
        const sku = rawSku.trim() ? normalizeArticle(rawSku) : 'IMP-' + Date.now() + '-' + lineNum

        const rawBrand = colMap.brand !== undefined ? parts[colMap.brand] ?? '' : ''
        const brand = rawBrand.trim()

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

        chunk.push({ sku, brand, name, price, qty, rowNum: lineNum })

        if (chunk.length >= 1000) {
          await processChunk(chunk, tenantId, supplierId, warehouseName)
          processedRows += chunk.length
          chunk = []

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

    if (chunk.length > 0) {
      await processChunk(chunk, tenantId, supplierId, warehouseName)
      processedRows += chunk.length
    }

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
    try {
      await fs.unlink(tempPath)
    } catch {}
  }
}

async function processChunk(
  items: Array<{ sku: string; brand: string; name: string; price: number; qty: number; rowNum: number }>,
  tenantId: string,
  supplierId: string | null,
  warehouseName: string | null
) {
  const rows = items.map((item) => ({
    tenant_id: tenantId,
    supplier_id: supplierId,
    sku: item.sku,
    brand: item.brand || null,
    name: item.name,
    price_kopecks: item.price,
    qty: String(item.qty),
    warehouse_name: warehouseName,
    updated_at: new Date().toISOString()
  }))

  const { error } = await db.from('supplier_price_items').insert(rows)
  if (error) {
    throw new Error('Помилка запису в supplier_price_items: ' + error.message)
  }
}
