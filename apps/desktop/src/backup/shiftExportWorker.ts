import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import path from 'node:path'
import * as XLSX from 'xlsx'

export async function exportShiftSnapshot(input: {
  snapshot: string; output: string; tenantId: string; stamp: string; closedAt: string; capturedAt: string
}) {
  await mkdir(input.output, { recursive: true })
  const db = new DatabaseSync(input.snapshot, { readOnly: true })
  try {
    if ((db.prepare('PRAGMA quick_check').get() as any)?.quick_check !== 'ok') throw new Error('Резервна копія не пройшла перевірку SQLite')
    for (const table of ['products','customers','staff_users']) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id<>? LIMIT 1`).get(input.tenantId))
        throw new Error('База містить дані кількох магазинів: повне серверне резервування зупинено для захисту доступу')
    }
    const products = db.prepare(`SELECT p.id, p.sku, p.barcode, p.name, p.unit,
      p.qty_on_hand, p.purchase_price, p.retail_price, p.storage_bin,
      p.is_active, p.is_service, c.name category, b.name brand,
      (SELECT group_concat(cross_number, ', ') FROM product_cross_numbers x
        WHERE x.product_id=p.id AND x.tenant_id=p.tenant_id AND x.deleted_at IS NULL) crosses
      FROM products p LEFT JOIN categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
      LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
      WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.name, p.id`).all(input.tenantId) as any[]
    const customers = db.prepare(`SELECT id, full_name, phone, email, card_barcode,
      birth_date, debt_balance, deposit_balance, bonus_balance, discount_pct, notes
      FROM customers WHERE tenant_id=? AND deleted_at IS NULL ORDER BY full_name, id`).all(input.tenantId) as any[]
    const vehicles = db.prepare(`SELECT v.customer_id, v.brand, v.model, v.year, v.vin, v.notes
      FROM customer_vehicles v JOIN customers c ON c.id=v.customer_id AND c.tenant_id=v.tenant_id
      WHERE v.tenant_id=? AND v.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY v.customer_id, v.id`).all(input.tenantId) as any[]
    const save = async (name: string, sheets: Array<{ name: string; headers: string[]; rows: any[][] }>) => {
      const book = XLSX.utils.book_new()
      for (const sheet of sheets) {
        const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows])
        ws['!cols'] = sheet.headers.map((header, i) => ({ wch: Math.min(60, Math.max(header.length + 2,
          ...sheet.rows.slice(0, 100).map(row => String(row[i] ?? '').length + 2))) }))
        ws['!autofilter'] = { ref: ws['!ref']! }
        // Text values remain strings (barcodes, leading zeros, formula-looking names).
        for (const [cell, value] of Object.entries(ws)) {
          if (!cell.startsWith('!') && value?.t === 'n') value.z = '#,##0.00'
        }
        XLSX.utils.book_append_sheet(book, ws, sheet.name)
      }
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
        ['Закриття зміни', input.closedAt], ['Час знімка бази', input.capturedAt],
        ['Призначення', 'Вивантаження для перегляду. Повна копія бази зберігається окремо.'],
      ]), 'Про вивантаження')
      const target = path.join(input.output, name + '_' + input.stamp + '.xlsx')
      await writeFile(target + '.partial', XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }))
      await rename(target + '.partial', target)
      return target
    }
    const productFile = await save('Товари', [{ name: 'Товари',
      headers: ['ID', 'Артикул', 'Штрихкод', 'Назва', 'Категорія', 'Бренд', 'Одиниця', 'Залишок', 'Закупка, грн', 'Продаж, грн', 'Полиця', 'Активний', 'Послуга', 'Крос-номери'],
      rows: products.map(p => [p.id, p.sku, p.barcode ?? '', p.name, p.category ?? '', p.brand ?? '', p.unit, Number(p.qty_on_hand), Number(p.purchase_price)/100, Number(p.retail_price)/100, p.storage_bin ?? '', p.is_active ? 'Так':'Ні', p.is_service ? 'Так':'Ні', p.crosses ?? '']),
    }])
    const customerFile = await save('Клієнти', [{ name: 'Клієнти',
      headers: ['ID', 'Ім’я', 'Телефон', 'Email', 'Штрихкод', 'Дата народження', 'Борг, грн', 'Власні кошти, грн', 'Бонуси, грн', 'Знижка, %', 'Примітки'],
      rows: customers.map(c => [c.id,c.full_name??'',c.phone??'',c.email??'',c.card_barcode??'',c.birth_date??'',Number(c.debt_balance)/100,Number(c.deposit_balance)/100,Number(c.bonus_balance)/100,Number(c.discount_pct),c.notes??'']),
    }, { name: 'Автомобілі', headers: ['ID клієнта', 'Марка', 'Модель', 'Рік', 'VIN', 'Примітки'],
      rows: vehicles.map(v=>[v.customer_id,v.brand,v.model,v.year??'',v.vin??'',v.notes??'']),
    }])
    const compressed = input.snapshot + '.gz'
    await pipeline(createReadStream(input.snapshot), createGzip(), createWriteStream(compressed + '.partial'))
    await rename(compressed + '.partial', compressed)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(compressed)) hash.update(chunk)
    return { productFile, customerFile, compressed, sha256: hash.digest('hex'), size: (await stat(compressed)).size, products: products.length, customers: customers.length }
  } finally { db.close() }
}
if (parentPort && workerData?.snapshot) exportShiftSnapshot(workerData).then(
  result => parentPort!.postMessage({ result }),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
)
