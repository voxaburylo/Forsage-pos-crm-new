import { api } from '@/lib/api'
import { dataUrlToBlob, removeProcessingUploads, uploadProcessingBlob } from '@/lib/processingUploads'
import { prepareImageDataUrl } from '@/lib/prepareImage'
import { checkPhoneInvoice, type PhoneInvoicePayload } from '@/features/tillCommands/phoneInvoiceModel'

/** Рядок форми на телефоні: усе текстом, як ввела людина. `extra` — поля розпізнавання, які форма не показує. */
export interface WebInvoiceRow { key: number; name: string; sku: string; qty: string; price: string; extra: Record<string, string> }
export const WEB_INVOICE_MAX_PHOTOS = 4

const text = (value: unknown, max: number) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max)
const numberText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(Math.round(value * 1000) / 1000) : ''

/**
 * Розпізнані рядки → рядки форми. Нічого не вигадуємо: нечитана кількість чи ціна лишається порожнім полем,
 * рядок без назви відкидається й рахується, щоб людина звірила кількість рядків із папером.
 */
export function recognizedInvoiceRows(products: unknown, firstKey = 1): { rows: WebInvoiceRow[]; skipped: number } {
  if (!Array.isArray(products)) throw new Error('Помічник не повернув рядки накладної. Спробуйте чіткіше фото.')
  const rows: WebInvoiceRow[] = []
  let skipped = 0
  for (const raw of products) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = text(item.name ?? item.source_name, 300)
    if (!name) { skipped++; continue }
    const extra: Record<string, string> = {}
    const keep: Array<[string, unknown, number]> = [['source_name', item.source_name, 300], ['barcode', item.barcode, 64],
      ['brand_name', item.brand_name ?? item.brand, 120], ['category_name', item.category_name, 120], ['unit', item.unit, 20]]
    for (const [key, value, max] of keep) { const part = text(value, max); if (part) extra[key] = part }
    rows.push({ key: firstKey + rows.length, name, sku: text(item.sku ?? item.article, 100), qty: numberText(item.qty), price: numberText(item.purchase_price_uah), extra })
  }
  return { rows, skipped }
}

/** Накладна з полів форми. Порожні рядки пропускаються; помилка називає рядок так, як його бачить людина. */
export function webInvoiceFromForm(form: { supplier: string; number: string; notes: string }, rows: readonly WebInvoiceRow[], author: string): PhoneInvoicePayload {
  const filled = rows.filter(row => row.name.trim() || row.sku.trim() || row.qty.trim() || row.price.trim())
  return checkPhoneInvoice({
    supplier_name: form.supplier, invoice_number: form.number, notes: form.notes, author,
    rows: filled.map(row => ({
      ...row.extra,
      // Назву змінили руками — стара «назва з накладної» більше не відповідає рядку.
      ...(row.extra.source_name && text(row.extra.source_name, 300) !== text(row.name, 300) ? { source_name: undefined } : {}),
      name: row.name, sku: row.sku, qty: row.qty.trim(), purchase_price_uah: row.price.trim(),
    })),
  })
}

interface Recognized { actions?: Array<{ payload?: { products?: unknown; supplier_name?: unknown; invoice_number?: unknown } }> }

/**
 * Розпізнає фото накладної (1–4 сторінки) через помічника. Потрібен інтернет і ввімкнений ШІ; кожне розпізнавання
 * платне, як і на касі. Фото лежать у тимчасовому сховищі лише на час запиту.
 */
export async function recognizeInvoicePhotos(files: readonly Blob[]): Promise<{ rows: WebInvoiceRow[]; skipped: number; supplier: string; number: string }> {
  if (!files.length) throw new Error('Додайте фото накладної.')
  if (files.length > WEB_INVOICE_MAX_PHOTOS) throw new Error(`За один раз — до ${WEB_INVOICE_MAX_PHOTOS} фото. Решту сторінок надішліть другою накладною.`)
  if (files.some(file => !file.type.startsWith('image/'))) throw new Error('Потрібні фото (JPG або PNG). PDF і таблиці приймає програма на касі.')
  const paths: string[] = []
  try {
    const images = []
    for (const file of files) {
      const compressed = dataUrlToBlob(await prepareImageDataUrl(file, { maxDimension: 2400, quality: 0.86 }))
      const uploaded = await uploadProcessingBlob(compressed, 'ai')
      paths.push(uploaded.path)
      images.push({ mime_type: compressed.type === 'image/png' ? 'image/png' : compressed.type === 'image/webp' ? 'image/webp' : 'image/jpeg', storage_path: uploaded.path })
    }
    const response = await api.post<{ data: Recognized }>('/api/v1/ai/supply-invoice-photo', { images }, undefined, { timeoutMs: 180_000, silent: true })
    const payload = response.data.actions?.[0]?.payload
    return { ...recognizedInvoiceRows(payload?.products), supplier: text(payload?.supplier_name, 200), number: text(payload?.invoice_number, 60) }
  } finally {
    await removeProcessingUploads(paths).catch(() => {})
  }
}
