import type { LocalDatabase } from '../db/localDatabase'

const text = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
const code = (value: unknown) => text(value).toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')
const notBrands = /^(?:dexron(?:\s*[ivx\d]+)?|atf|api|sae|acea|dot[ -]?\d|gl[ -]?\d|sl\/?cf|metal|metall|метал|металл)$/i
export const invoiceBrand = (raw: Record<string, unknown>) => {
  const value = text(raw.brand ?? raw.brand_name)
  return notBrands.test(value) ? '' : value
}
function words(value: unknown): string[] {
  return text(value).toLowerCase()
    .replace(/[\p{L}\p{N}-]+/gu, word => /[a-z]/.test(word) ? word.replace(/[аесорхуі]/g, c => ({ а:'a', е:'e', с:'c', о:'o', р:'p', х:'x', у:'y', і:'i' }[c]!)) : word)
    .replace(/\bmetall?\b|металл?/g, 'метал')
    .replace(/(\d)\s*(?:л|l)(?=$|[^\p{L}\p{N}])/gu, '$1л')
    .replace(/(\d)\s*(?:мл|ml)(?=$|[^\p{L}\p{N}])/gu, '$1мл')
    .match(/[\p{L}\p{N}]+/gu) ?? []
}
function withBrand(name: unknown, brand: unknown): string {
  const nameWords = words(name), brandWords = words(brand)
  return brandWords.every(word => nameWords.includes(word)) ? text(name) : `${text(name)} ${text(brand)}`.trim()
}
const identity = (name: unknown, brand: unknown) => {
  const full = withBrand(name, brand)
  // Word order may vary; dimensions and model-number order must not.
  const numbers = text(full).match(/\d+(?:[.,]\d+)?/g)?.map(value => value.replace(',', '.')) ?? []
  return JSON.stringify([words(full).sort(), numbers])
}

/** Reorders known information, never truncates specifications or invents a manufacturer. */
export function aiInvoiceProductName(raw: Record<string, unknown>): string {
  const source = text(raw.name ?? raw.title ?? raw.description), brand = invoiceBrand(raw)
  let name = source
  const material = name.match(/^\((?:металл?|metall?)\)\s*/i)?.[0]
  if (material) name = name.slice(material.length)
  const grade = name.match(/\b(?:0|5|10|15|20|25)\s*W\s*-?\s*(?:16|20|30|40|50|60)\b/i)?.[0]
  const oil = Boolean(grade && (material || (brand && /^(?:масло|олива|моторн)/i.test(name))))
  if (oil) {
    name = name.replace(/^(?:(?:масло|олива|моторное|моторна|моторне)\s+)+/i, '')
    const volume = name.match(/\b\d+(?:[.,]\d+)?\s*(?:л|l)(?=$|[^\p{L}\p{N}])/iu)?.[0]
    const brandPattern = brand ? new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : /$^/
    const remainder = name.replace(grade!, '').replace(volume ?? /$^/, '').replace(brandPattern, '').trim()
    name = ['Олива', brand, grade!.replace(/\s/g, ''), volume, remainder].filter(Boolean).join(' ')
  } else if (brand && identity(name, '') !== identity(name, brand)) {
    const first = name.match(/^\S+/)?.[0] ?? ''
    name = /^[\p{L}]+$/u.test(first) ? `${first} ${brand}${name.slice(first.length)}` : `${brand} ${name}`
  }
  return text(name + (material ? ' (метал)' : ''))
}

export interface AiInvoiceCandidate { id: string; name: string; sku: string; barcode: string | null; brand: string | null }
export interface AiInvoiceReview {
  name: string; source_name: string; brand: string; product_id: string | null
  status: 'matched' | 'review' | 'new'; reason: string; candidates: AiInvoiceCandidate[]
}

/** One catalog snapshot per invoice. Similarity produces suggestions ONLY, never an automatic merge. */
export class AiInvoiceMatcher {
  private products = new Map<string, AiInvoiceCandidate>()
  private skus = new Map<string, Set<string>>()
  private barcodes = new Map<string, Set<string>>()
  private names = new Map<string, Set<string>>()
  private tokens = new Map<string, Set<string>>()
  constructor(db: Pick<LocalDatabase, 'prepare'>, tenant: string) {
    const products = db.prepare(`SELECT p.id,p.name,p.sku,p.barcode,b.name AS brand FROM products p
      LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
      WHERE p.tenant_id=? AND p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0`).all(tenant) as unknown as AiInvoiceCandidate[]
    for (const product of products) this.add(product)
    for (const row of db.prepare(`SELECT b.product_id,b.barcode FROM product_barcodes b JOIN products p ON p.id=b.product_id AND p.tenant_id=b.tenant_id
      WHERE b.tenant_id=? AND b.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0`).all(tenant) as Array<{ product_id: string; barcode: string }>) this.index(this.barcodes, code(row.barcode), row.product_id)
  }
  private index(map: Map<string, Set<string>>, key: string, id: string) {
    if (!key) return
    const ids = map.get(key) ?? new Set<string>(); ids.add(id); map.set(key, ids)
  }
  add(product: AiInvoiceCandidate, sourceName?: string) {
    this.products.set(product.id, product)
    this.index(this.skus, code(product.sku), product.id)
    this.index(this.barcodes, code(product.barcode), product.id)
    this.index(this.names, identity(product.name, product.brand), product.id)
    if (sourceName) this.index(this.names, identity(sourceName, product.brand), product.id)
    for (const token of new Set(words(`${product.name} ${product.brand ?? ''} ${product.sku}`))) this.index(this.tokens, token, product.id)
  }
  review(raw: Record<string, unknown>): AiInvoiceReview {
    const source = text(raw.source_name ?? raw.name ?? raw.title ?? raw.description), brand = invoiceBrand(raw)
    const result: AiInvoiceReview = { source_name: source, name: aiInvoiceProductName(raw), brand, product_id: null, status: 'new', reason: 'Новий товар — без штрихкоду', candidates: [] }
    const ids = new Set([...(this.barcodes.get(code(raw.barcode ?? raw.ean)) ?? []), ...(this.skus.get(code(raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number)) ?? [])])
    if (!ids.size) for (const id of this.names.get(identity(source, brand)) ?? []) ids.add(id)
    if (ids.size === 1) {
      const product = this.products.get([...ids][0])!
      return { ...result, status: 'matched', product_id: product.id, name: product.name, brand: product.brand ?? '', reason: 'Знайдено точний код або повну назву з брендом', candidates: [product] }
    }
    let candidates = [...ids].map(id => this.products.get(id)!)
    if (!candidates.length) {
      const scores = new Map<string, number>()
      const terms = new Set(words(`${source} ${brand} ${raw.sku ?? raw.article ?? ''}`))
      for (const digits of text(raw.sku ?? raw.article).match(/\d{4,}/g) ?? []) terms.add(digits)
      for (const token of terms) {
        const entries = this.tokens.get(token)
        if (!entries || entries.size > 1000 || token.length < 3) continue
        const weight = /^\d{4,}$/.test(token) ? 4 : 1
        for (const id of entries) scores.set(id, (scores.get(id) ?? 0) + weight)
      }
      candidates = [...scores].filter(([, score]) => score >= 4).sort((a,b) => b[1]-a[1]).slice(0,8).map(([id]) => this.products.get(id)!)
    }
    if (candidates.length) return { ...result, status: 'review', reason: ids.size > 1 ? 'Коди або повна назва належать кільком карткам — виберіть товар' : 'Є схожі товари — перевірте, щоб не створити дубль', candidates }
    return result
  }
  resolve(raw: Record<string, unknown>): AiInvoiceReview {
    const review = this.review(raw), choice = text(raw.match_choice)
    if (choice && choice !== 'new') {
      const product = this.products.get(choice)
      if (!product) throw new Error('Вибрану картку видалено або вимкнено. Повторно звірте товар.')
      return { ...review, status: 'matched', product_id: product.id, name: product.name, brand: product.brand ?? '' }
    }
    if (review.status === 'review' && choice !== 'new') throw new Error(`«${review.source_name}»: ${review.reason}. Відкрийте перевірку накладної. Нові картки не створено.`)
    return review
  }
}
