import { api } from '@/lib/api'
import { dataUrlToBlob, removeProcessingUploads, uploadProcessingBlob } from '@/lib/processingUploads'
import { prepareImageDataUrl } from '@/lib/prepareImage'
import { cropThumbnail, loadImage, readImageBox } from './cartThumbnails'

/** Рядок, розпізнаний зі скриншота кошика постачальника (22.11.2026, етап 2 плану). */
export interface CartScreenshotRow { name: string; sku: string; qty: string; buy_price: string; photo_data_url?: string }

const text = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()

/**
 * Перетворює розпізнані рядки на позиції замовлення. Нічого не вигадує: рядок без назви відкидається
 * з повідомленням, нечитана кількість стає 1 лише коли її справді не було в джерелі, ціна продажу
 * не заповнюється — її ставить менеджер вручну або швидким відсотком.
 */
export function cartScreenshotRows(products: unknown): { rows: CartScreenshotRow[]; skipped: number } {
  if (!Array.isArray(products)) throw new Error('ШІ не повернув список позицій. Спробуйте чіткіший скриншот.')
  if (products.length > 200) throw new Error('На скриншоті забагато рядків. Розбийте його на частини.')
  const rows: CartScreenshotRow[] = []
  let skipped = 0
  for (const raw of products) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const baseName = text(item.source_name ?? item.name), brand = text(item.brand_name ?? item.brand)
    if (!baseName) { skipped++; continue }
    const name = brand && !baseName.toLowerCase().includes(brand.toLowerCase()) ? `${baseName} ${brand}` : baseName
    const qty = Number(item.qty ?? item.quantity)
    const price = Number(item.purchase_price_uah ?? item.price)
    rows.push({
      name,
      sku: text(item.sku ?? item.article),
      qty: Number.isFinite(qty) && qty > 0 && qty <= 100_000 ? String(qty) : '1',
      buy_price: Number.isFinite(price) && price > 0 && price <= 10_000_000 ? String(Math.round(price * 100) / 100) : '0',
    })
  }
  return { rows, skipped }
}

const INSTRUCTION = 'Це скриншот КОШИКА на сайті постачальника автозапчастин, а не накладна. Перенеси кожний рядок кошика: назву, артикул (код біля назви), бренд, кількість і ціну за одиницю як закупівельну. Колонки наявності по складах і підсумкову суму рядка не плутай із кількістю та ціною. Якщо в рядку є картинка товару, у image_box вкажи її межі: [ліво, верх, ширина, висота] у відсотках від усього скриншота; немає картинки — не заповнюй.'

/** Розпізнає скриншот кошика через помічника (потрібен інтернет і ввімкнений ШІ). */
export async function recognizeCartScreenshot(file: Blob): Promise<{ rows: CartScreenshotRow[]; skipped: number }> {
  if (!file.type.startsWith('image/')) throw new Error('Вставте зображення: скриншот кошика у форматі PNG або JPG')
  const compressed = dataUrlToBlob(await prepareImageDataUrl(file, { maxDimension: 2000, quality: 0.86 }))
  const uploaded = await uploadProcessingBlob(compressed, 'ai')
  try {
    const response = await api.post<{ data: { actions?: Array<{ payload?: { products?: unknown } }> } }>('/api/v1/ai/supply-invoice-photo', {
      message: INSTRUCTION,
      images: [{ mime_type: compressed.type === 'image/png' ? 'image/png' : compressed.type === 'image/webp' ? 'image/webp' : 'image/jpeg', storage_path: uploaded.path }],
    }, undefined, { timeoutMs: 180_000, silent: true })
    const products = response.data.actions?.[0]?.payload?.products
    const result = cartScreenshotRows(products)
    // 24.11.2026 (план C2): мініатюра товару зі скриншота — лише там, де ШІ показав правдоподібні межі.
    const boxes = Array.isArray(products) ? products.filter(raw => String((raw as Record<string, unknown>)?.source_name ?? (raw as Record<string, unknown>)?.name ?? '').trim()).map(raw => readImageBox((raw as Record<string, unknown>)?.image_box)) : []
    if (boxes.some(Boolean)) {
      const image = await loadImage(compressed)
      if (image) result.rows.forEach((row, index) => { const box = boxes[index]; const thumb = box ? cropThumbnail(image, box) : null; if (thumb) row.photo_data_url = thumb })
    }
    return result
  } finally {
    await removeProcessingUploads([uploaded.path]).catch(() => {})
  }
}
