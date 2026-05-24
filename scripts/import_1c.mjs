/**
 * Скрипт імпорту 1С XLS → CRM API
 * Читає ієрархічний формат 1С (рядки-заголовки = групи, рядки з артикулом = товари)
 * Запускати: node scripts/import_1c.mjs
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const require = createRequire(import.meta.url)
const XLSX = require('../apps/web/node_modules/xlsx/xlsx.js')

const API_URL  = 'https://forsage-pos-crm-new.onrender.com'
const PHONE    = '+380635823858'
const PASSWORD = '80676462789'
const FILE     = 'C:/Users/neo/Desktop/Новый2.xls'
const BATCH    = 300   // рядків за один запит

// ── 1. Логін ──────────────────────────────────────────────────────────────────
async function login() {
  console.log('🔐 Логін...')
  const res = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`Логін не вдався: ${res.status}`)
  const { access_token } = await res.json()
  console.log('  ✅ Токен отримано')
  return access_token
}

// ── 2. Парсинг XLS ────────────────────────────────────────────────────────────
function parseXls(filePath) {
  console.log(`📂 Читаю файл: ${filePath}`)
  const wb   = XLSX.readFile(filePath)
  const ws   = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  console.log(`  Рядків у файлі: ${rows.length}`)

  const items = []
  let currentGroup = ''

  for (let i = 1; i < rows.length; i++) {
    const row  = rows[i]
    const sku  = String(row[2] ?? '').trim()
    const name = String(row[3] ?? '').trim()
    const unit = String(row[6] ?? 'шт').trim() || 'шт'

    if (!name) continue

    if (!sku) {
      // Рядок-заголовок групи
      currentGroup = name
      continue
    }

    // Рядок товару
    items.push({
      row:            i + 1,
      sku,
      name,
      category:       currentGroup || undefined,
      unit,
      retail_price:   0,
      purchase_price: 0,
      qty:            0,
    })
  }

  const groups = [...new Set(items.map(p => p.category).filter(Boolean))]
  console.log(`  ✅ Товарів: ${items.length} | Груп: ${groups.length}`)
  return items
}

// ── 3. Імпорт батчами ─────────────────────────────────────────────────────────
async function importBatch(token, rows, batchNum) {
  const res = await fetch(`${API_URL}/api/v1/import/1c/run`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      rows,
      mode:         'replace',
      updatePrices: false,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Batch ${batchNum} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  return data.data ?? data
}

// ── Головна функція ───────────────────────────────────────────────────────────
async function main() {
  try {
    let token = await login()
    let tokenTime = Date.now()
    const TOKEN_TTL = 45 * 60 * 1000  // оновлюємо кожні 45 хв (expire через 60 хв)

    const items = parseXls(FILE)

    let created = 0, updated = 0, catCreated = 0, errors = 0
    const totalBatches = Math.ceil(items.length / BATCH)

    console.log(`\n🚀 Починаю імпорт: ${items.length} товарів, ${totalBatches} батчів по ${BATCH}...\n`)

    for (let b = 0; b < totalBatches; b++) {
      // Оновлюємо токен якщо майже закінчується
      if (Date.now() - tokenTime > TOKEN_TTL) {
        process.stdout.write('\n  🔄 Оновлення токена...')
        token = await login()
        tokenTime = Date.now()
        process.stdout.write(' ✅\n')
      }

      const batch = items.slice(b * BATCH, (b + 1) * BATCH)
      const result = await importBatch(token, batch, b + 1)

      created    += result.created    ?? 0
      updated    += result.updated    ?? 0
      catCreated += result.categories_created ?? 0
      errors     += result.errors?.length ?? 0

      const pct = Math.round((b + 1) / totalBatches * 100)
      process.stdout.write(`\r  Батч ${b + 1}/${totalBatches} (${pct}%) | +${created} нових | ~${updated} оновлено | помилок: ${errors}  `)
    }

    console.log('\n\n✅ Імпорт завершено!')
    console.log(`  Створено товарів:    ${created}`)
    console.log(`  Оновлено товарів:    ${updated}`)
    console.log(`  Нових категорій:     ${catCreated}`)
    console.log(`  Помилок:             ${errors}`)

  } catch (err) {
    console.error('\n❌ Помилка:', err.message)
    process.exit(1)
  }
}

main()
