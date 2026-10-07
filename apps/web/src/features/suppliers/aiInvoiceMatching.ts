import type { desktopBridge } from '@/lib/desktopBridge'
import { invoiceProductBase, roundRetailBySettings, type LineItem } from './invoiceFormModel'

type Supply = NonNullable<NonNullable<ReturnType<typeof desktopBridge>>['supply']>
export type InvoiceMatch = Awaited<ReturnType<NonNullable<Supply['previewInvoiceFromAi']>>>[number]
export type InvoiceCandidate = InvoiceMatch['candidates'][number]
const value = (raw: unknown) => String(raw ?? '').trim()
const numeric = (raw: unknown) => Number(value(raw).replace(/\s/g, '').replace(',', '.'))
const categoryKey = (raw: unknown) => value(raw).normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ')

/** Current invoice fields, not an old recognition snapshot, are authoritative. */
export function invoiceMatchInput(item: LineItem): Record<string, unknown> {
  return { ...item.ai_review?.source, name: item.product_name,
    source_name: item.product_id ? item.ai_review?.source.source_name ?? item.ai_review?.source.name : item.product_name,
    sku: item.sku, barcode: item.barcode || (item.product_id ? '' : item.ai_review?.source.barcode ?? ''), unit: item.unit,
    qty: item.qty, purchase_price_uah: item.purchase_price / 100,
    match_choice: item.product_id || item.ai_review?.choice || '' }
}
export function invoiceMatchProblems(item: LineItem): string[] {
  const review = item.ai_review?.result
  if (!review) return []
  const errors = [...(review.validation_errors ?? [])]
  if (review.status === 'review' && !item.product_id && !item.ai_review?.choice) errors.push(review.reason)
  return [...new Set(errors)]
}
export function bindInvoiceCandidate(item: LineItem, product: InvoiceCandidate): LineItem {
  const base = invoiceProductBase({ ...product, retail_price: product.retail_price ?? 0 })
  return { ...item, product_id: product.id, product_base: base, is_new: false,
    product_name: product.name, sku: product.sku, barcode: product.barcode || '',
    category_id: product.category_id ?? null, storage_bin: product.storage_bin ?? null,
    photo_url: product.photo_url ?? null, ai_category_name: undefined,
    // Quantity, unit and invoice purchase price must never be taken from stock/card.
    retail_price: item.retail_price > 0 ? item.retail_price : product.retail_price ?? 0,
    ai_review: item.ai_review ? { ...item.ai_review, choice: product.id } : undefined }
}
export function applyInvoiceMatch(item: LineItem, review: InvoiceMatch): LineItem {
  const choice = item.product_id || (item.ai_review?.choice !== 'new' ? item.ai_review?.choice : '') || review.product_id
  const product = review.candidates.find(candidate => candidate.id === choice)
  const next = product && product.id !== item.product_id ? bindInvoiceCandidate(item, product) : item
  return { ...next, ai_review: { ...next.ai_review!, result: review } }
}
export function aiRowsToInvoiceItems(rows: Record<string, unknown>[], reviews: InvoiceMatch[], categories: Array<{id:string;name:string}>, settings: Record<string, any>): LineItem[] {
  if (rows.length !== reviews.length || !rows.length) throw new Error('Перевірено не всі рядки накладної')
  return rows.map((raw,index) => {
    const review = reviews[index], qty = numeric(raw.qty ?? raw.quantity ?? raw.qty_on_hand)
    const purchase = Math.round(numeric(raw.purchase_price_uah ?? raw.purchase_price ?? raw.cost_price) * 100)
    const suggested = value(raw.category_name ?? raw.category ?? raw.folder_name ?? raw.folder)
    const category = categories.find(item => categoryKey(item.name) === categoryKey(suggested))
    const matchedCategory = review.candidates.find(candidate => candidate.id === review.product_id)?.category_id
    const categoryMarkup = settings.category_markups?.find((rule: any) => rule.category_id === (matchedCategory ?? category?.id))
    const rule = settings.markup_rules?.find((rule: any) => purchase >= Number(rule.minPrice) && purchase < Number(rule.maxPrice))
    const retail = roundRetailBySettings(Math.round(purchase * (1 + Number(categoryMarkup?.markup_pct ?? rule?.markupPct ?? 30) / 100)), settings)
    const item: LineItem = {
      client_key: crypto.randomUUID(), product_name: review.name, sku: value(raw.sku ?? raw.article),
      barcode: '', unit: value(raw.unit) || 'шт', qty: Number.isFinite(qty) ? qty : 0,
      purchase_price: Number.isFinite(purchase) ? purchase : 0, retail_price: retail,
      total: Number.isFinite(qty * purchase) ? Math.round(qty * purchase) : 0,
      category_id: category?.id ?? null, is_new: true,
      ai_category_name: !category && suggested && suggested.length <= 120 && !/^(без папки|без категорії|без категории|невідомо|unknown|null)$/i.test(suggested) ? suggested : undefined,
      ai_review: { source: { ...raw, source_name: review.source_name }, choice: value(raw.match_choice), result: review },
    }
    return applyInvoiceMatch(item, review)
  })
}
