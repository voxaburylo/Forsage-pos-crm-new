import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { checkedAiSupplyUnit, checkedAiSupplyQuantity, checkedAiSupplyPrice, normalizeSupplyItem } from './supplyValidation'

const text = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
const code = (value: unknown) => {
  let valueText = text(value).toUpperCase()
  // Supplier part numbers often mix visually identical Cyrillic and Latin letters.
  if (/\d/.test(valueText) && /^[A-ZАВЕКМНОРСТХУІ\d\s./()-]+$/u.test(valueText)) {
    valueText = valueText.replace(/[АВЕКМНОРСТХУІ]/g, c => ({ А:'A', В:'B', Е:'E', К:'K', М:'M', Н:'H', О:'O', Р:'P', С:'C', Т:'T', Х:'X', У:'Y', І:'I' }[c]!))
  }
  return valueText.replace(/[^\p{L}\p{N}]/gu, '')
}
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

export interface AiInvoiceCandidate { id: string; name: string; sku: string; barcode: string | null; brand: string | null; unit?: string | null; retail_price?: number; category_id?: string | null; storage_bin?: string | null; photo_url?: string | null }
export interface AiInvoiceReview {
  name: string; source_name: string; brand: string; product_id: string | null
  status: 'matched' | 'review' | 'new'; reason: string; candidates: AiInvoiceCandidate[]
  validation_errors?: string[]; already_saved?: boolean; invoice_id?: string
}

function partNumbers(value: string): string[] {
  return (text(value).match(/[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*/gu) ?? [])
    .filter(token => (/^[0-9]{6,}$/.test(token) || (/[\p{L}]/u.test(token) && (token.match(/\d/g)?.length ?? 0) >= 3 && code(token).length >= 5))
      && !/^\d{1,2}w-?\d{2}$/i.test(token) && !/^\d+(?:mm|ml|мм|мл)$/i.test(token)
      && !/^\d+(?:[xх×]\d+)+/iu.test(token) && !/^(?:API|ACEA|SAE|ISO|DOT|GL)[-\d]/i.test(token))
    .map(code)
}
const brandKey = (value: string) => {
  const key = code(value)
  return ({ БРТ:'BRT', ССД:'SSD' } as Record<string,string>)[key] ?? key
}
// Line numbers / pack counts are not a product identity, even if an old import used them as SKU.
function weakCode(value: unknown): boolean {
  const raw = text(value)
  return /^\(?\d{1,3}\)?$/.test(raw) || /^(?:AI-[A-F\d]{8}|AUTO-)/i.test(raw)
}
function variant(name: string) {
  const lower = text(name).toLowerCase()
  const side = (a: RegExp, b: RegExp) => a.test(lower) !== b.test(lower) ? (a.test(lower) ? 'a' : 'b') : ''
  const volume = [...lower.matchAll(/(?:^|[^\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*(мл|ml|л|l)(?=$|[^\p{L}\p{N}])/gu)]
    .map(m => Math.round(Number(m[1].replace(',', '.')) * (/^(?:л|l)$/.test(m[2]) ? 1000 : 1)))
  const grade = lower.match(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*w\s*-?\s*(\d{2})(?=$|[^\p{L}\p{N}])/u)
  return {
    volume: [...new Set(volume)].sort((a,b) => a-b).join('/'),
    grade: grade ? grade[1] + 'w' + grade[2] : '',
    side: side(/(?:^|[^\p{L}])(?:лев[а-яіїєґ]*|лів[а-яіїєґ]*|left)(?=$|[^\p{L}])/u, /(?:^|[^\p{L}])(?:прав[а-яіїєґ]*|right)(?=$|[^\p{L}])/u),
    finish: side(/(?:^|[^\p{L}])(?:черн[а-яіїєґ]*|чорн[а-яіїєґ]*|black)(?=$|[^\p{L}])/u, /(?:^|[^\p{L}])(?:хром[а-яіїєґ]*|chrome)(?=$|[^\p{L}])/u),
    light: side(/(?:^|[^\p{L}])(?:светл[а-яіїєґ]*|світл[а-яіїєґ]*)(?=$|[^\p{L}])/u, /(?:^|[^\p{L}])темн[а-яіїєґ]*(?=$|[^\p{L}])/u),
  }
}
function incompatible(source: string, brand: string, product: AiInvoiceCandidate): boolean {
  const sourceVariant = variant(source), productVariant = variant(product.name)
  for (const key of Object.keys(sourceVariant) as Array<keyof typeof sourceVariant>) {
    if (sourceVariant[key] && productVariant[key] && sourceVariant[key] !== productVariant[key]) return true
  }
  if (brand && product.brand && brandKey(brand) !== brandKey(product.brand)) return true
  const length = (name: string) => name.match(/(?:^|[\s(])L\s*[-=:]?\s*(\d{2,4})(?=$|\D)/i)?.[1]
  const a = length(source), b = length(product.name)
  if (a && b && a !== b) return true
  const axle = (name: string) => {
    const lower = name.toLocaleLowerCase()
    const front = /(?:^|\s)(?:перед[а-яіїєґ]*|front)(?:\s|$)/u.test(lower)
    const rear = /(?:^|\s)(?:зад[а-яіїєґ]*|rear)(?:\s|$)/u.test(lower)
    return front !== rear ? (front ? 'front' : 'rear') : ''
  }
  return !!(axle(source) && axle(product.name) && axle(source) !== axle(product.name))
}

/** Save a full source name only after the invoice has an explicit, validated catalog binding. */
export function rememberInvoiceProductName(db: Pick<LocalDatabase, 'prepare'>, tenant: string, productId: string, raw: Record<string, unknown>): void {
  const source = text(raw.source_name ?? raw.name), brand = invoiceBrand(raw)
  if (source.length < 8 || source.length > 1000 || words(source).length < 3) return
  const product = db.prepare(`SELECT p.id,p.name,p.sku,p.barcode,b.name brand FROM products p LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
    WHERE p.id=? AND p.tenant_id=? AND p.deleted_at IS NULL AND p.is_active=1`).get(productId, tenant) as unknown as AiInvoiceCandidate | undefined
  if (!product || incompatible(source, brand, product)) return
  const alias = withBrand(source, brand)
  if (identity(alias, product.brand) === identity(product.name, product.brand)) return
  if (db.prepare('SELECT 1 FROM product_aliases WHERE tenant_id=? AND product_id=? AND alias=? AND deleted_at IS NULL').get(tenant,productId,alias)) return
  const timestamp = new Date().toISOString()
  db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(),tenant,productId,alias,timestamp,timestamp)
}

/** Shared by the read-only worker and repository. A committed retry preserves its original payload. */
export function previewAiInvoiceRows(db: Pick<LocalDatabase, 'prepare'>, tenant: string, rows: Array<Record<string, unknown>>, operationId?: string): AiInvoiceReview[] {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error('Перевірте таблицю товарів (до 2000 рядків).')
  if (operationId) {
    const receipt = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get('mutation:ai-invoice:' + tenant + ':' + operationId) as { value_json: string } | undefined
    if (receipt) {
      const saved = JSON.parse(receipt.value_json)
      if (saved.cancelled) throw new Error('Цю спробу вже закрито без проведення. Старий запит не виконано.')
      if (!saved.result?.invoice?.id || !Array.isArray(saved.result?.draft_items) || saved.result.draft_items.length !== rows.length) {
        throw new Error('Для цієї спроби вже є збережений документ з іншими даними. Відкрийте його в «Поступленні товарів».')
      }
      return rows.map((raw,index) => {
        const item = saved.result.draft_items[index]
        return { source_name: text(raw.source_name ?? raw.name), name: text(raw.name), brand: invoiceBrand(raw),
          product_id: item.product_id, status: 'matched', reason: 'Накладну вже збережено; повтор відкриє ту саму чернетку',
          candidates: [{ id: item.product_id, name: item.product_name, sku: item.sku, barcode: item.barcode || null, brand: null, unit: item.unit }],
          validation_errors: [], already_saved: true, invoice_id: saved.result.invoice.id }
      })
    }
  }
  return new AiInvoiceMatcher(db, tenant).previewRows(rows)
}

/** One catalog snapshot per invoice. Similarity suggests; only unique exact identities auto-match. */
export class AiInvoiceMatcher {
  private products = new Map<string, AiInvoiceCandidate>()
  private skus = new Map<string, Set<string>>()
  private barcodes = new Map<string, Set<string>>()
  private names = new Map<string, Set<string>>()
  private parts = new Map<string, Set<string>>()
  private archivedSkus = new Set<string>()
  private archivedLinks = new Map<string, Set<string>>()
  private tokens = new Map<string, Set<string>>()
  constructor(db: Pick<LocalDatabase, 'prepare'>, tenant: string) {
    const products = db.prepare(`SELECT p.id,p.name,p.sku,p.barcode,p.unit,p.retail_price,p.category_id,p.storage_bin,p.photo_url,b.name AS brand FROM products p
      LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
      WHERE p.tenant_id=? AND p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0`).all(tenant) as unknown as AiInvoiceCandidate[]
    for (const product of products) this.add(product)
    for (const row of db.prepare(`SELECT b.product_id,b.barcode FROM product_barcodes b JOIN products p ON p.id=b.product_id AND p.tenant_id=b.tenant_id
      WHERE b.tenant_id=? AND b.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0`).all(tenant) as Array<{ product_id: string; barcode: string }>) this.index(this.barcodes, code(row.barcode), row.product_id)
    for (const row of db.prepare(`SELECT a.product_id,a.alias,p.name,b.name AS brand FROM product_aliases a
      JOIN products p ON p.id=a.product_id AND p.tenant_id=a.tenant_id
      LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
      WHERE a.tenant_id=? AND a.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_active=1 AND p.is_service=0`).all(tenant) as Array<{ product_id: string; alias: string; name: string; brand: string | null }>) {
      // Aliases are full, explicitly saved names; a generic short word or number never auto-links.
      if (words(row.alias).length >= 3 && !incompatible(row.alias, row.brand ?? '', this.products.get(row.product_id)!)) {
        this.index(this.names, identity(row.alias, row.brand), row.product_id)
      }
    }
    const archived = db.prepare(`SELECT p.sku,p.name,p.specs_json,b.name AS brand FROM products p
      LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id
      WHERE p.tenant_id=? AND p.deleted_at IS NOT NULL AND p.is_service=0`).all(tenant) as Array<{ sku: string; name: string; specs_json: string; brand: string | null }>
    for (const row of archived) {
      const sku = code(row.sku)
      if (!sku) continue
      this.archivedSkus.add(sku)
      // A manual audited merge is durable identity evidence, not an automatic archive restore.
      let merged: unknown
      try { merged = JSON.parse(row.specs_json || '{}').merged_into_product_id } catch { /* legacy metadata */ }
      if (typeof merged === 'string' && this.products.has(merged)) {
        if (!weakCode(row.sku)) this.index(this.skus, sku, merged)
        this.index(this.names, identity(row.name, row.brand), merged)
        for (const part of partNumbers(row.sku + ' ' + row.name)) this.index(this.parts, part, merged)
      } else if (!weakCode(row.sku)) {
        // Short pack codes such as (12) must never bridge to unrelated archived cards.
        for (const id of this.names.get(identity(row.name, row.brand)) ?? []) this.index(this.archivedLinks, sku, id)
      }
    }
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
    for (const part of partNumbers(product.name + ' ' + product.sku)) this.index(this.parts, part, product.id)
    for (const token of new Set(words(`${product.name} ${product.brand ?? ''} ${product.sku}`))) this.index(this.tokens, token, product.id)
  }
  review(raw: Record<string, unknown>): AiInvoiceReview {
    const source = text(raw.source_name ?? raw.name ?? raw.title ?? raw.description), brand = invoiceBrand(raw)
    const result: AiInvoiceReview = { source_name: source, name: aiInvoiceProductName(raw), brand, product_id: null, status: 'new', reason: 'Новий товар — без штрихкоду', candidates: [] }
    const rawSku = text(raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number), sku = code(rawSku)
    const exactNames = this.names.get(identity(source, brand)) ?? new Set<string>()
    const skuIds = [...(this.skus.get(sku) ?? [])].filter(id => !weakCode(rawSku) || exactNames.has(id))
    const ids = new Set([...(this.barcodes.get(code(raw.barcode ?? raw.ean)) ?? []), ...skuIds])
    let reason = 'Точний штрихкод або артикул'
    if (!ids.size && sku && !weakCode(rawSku)) {
      for (const id of this.archivedLinks.get(sku) ?? []) ids.add(id)
      if (ids.size) reason = 'Активна картка з тією ж повною назвою, що й стара картка цього артикула'
      if (!ids.size && partNumbers(text(raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number)).includes(sku)) {
        for (const id of this.parts.get(sku) ?? []) ids.add(id)
        if (ids.size) reason = 'Точний каталожний номер у назві товару'
      }
    }
    if (!ids.size) {
      for (const id of this.names.get(identity(source, brand)) ?? []) ids.add(id)
      reason = 'Точна повна назва з брендом'
    }
    if (!ids.size) {
      // A complete factory number (including six-digit lubricant references) may be in the name.
      // Standards, viscosities and short pack/line numbers are not eligible part numbers.
      for (const part of partNumbers(source)) {
        for (const id of this.parts.get(part) ?? []) {
          if (!incompatible(source, brand, this.products.get(id)!)) ids.add(id)
        }
      }
      if (ids.size) reason = 'Повний каталожний номер із назви, без конфлікту характеристик'
    }
    if (ids.size === 1) {
      const product = this.products.get([...ids][0])!
      if (!incompatible(source, brand, product)) return { ...result, status: 'matched', product_id: product.id, name: product.name, brand: product.brand ?? '', reason, candidates: [product] }
      return { ...result, status: 'review', reason: 'Код збігається, але бренд, фасування, в’язкість або сторона відрізняються — перевірте рядок', candidates: [product] }
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
      candidates = [...scores].filter(([id, score]) => score >= 4 && !incompatible(source, brand, this.products.get(id)!))
        .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,8).map(([id]) => this.products.get(id)!)
    }
    if (candidates.length) return { ...result, status: 'review', reason: ids.size > 1 ? 'Коди або повна назва належать кільком карткам — виберіть товар' : 'Є схожі товари — перевірте, щоб не створити дубль', candidates }
    return result
  }
  preview(raw: Record<string, unknown>): AiInvoiceReview {
    const review = this.review(raw), errors: string[] = []
    const check = (fn: () => unknown) => { try { fn() } catch (error) { errors.push(error instanceof Error ? error.message : 'Перевірте рядок') } }
    const choice = text(raw.match_choice)
    const product = this.products.get(choice && choice !== 'new' ? choice : review.product_id ?? '')
    if (!text(raw.name ?? raw.title ?? raw.description)) errors.push('Відсутня назва товару')
    check(() => normalizeSupplyItem({ qty: checkedAiSupplyQuantity(raw.qty ?? raw.quantity ?? raw.qty_on_hand), purchase_price: checkedAiSupplyPrice(raw.purchase_price_uah ?? raw.purchase_price ?? raw.cost_price) }))
    check(() => checkedAiSupplyUnit(raw.unit, product ? product.unit ?? 'шт' : undefined, 'Рядок'))
    if (choice && choice !== 'new' && !product) errors.push('Вибрану картку видалено або вимкнено. Виберіть товар повторно.')

    if (!product && choice === 'new' && review.status === 'review' && (
      this.skus.has(code(raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number)) ||
      this.barcodes.has(code(raw.barcode ?? raw.ean)) ||
      this.names.has(identity(review.source_name, invoiceBrand(raw)))
    )) errors.push('Цей код або повна назва належать наявним карткам. Виберіть товар або виправте реквізити нового; дубль не створено.')
    if (!product && (choice === 'new' || review.status === 'new') && this.archivedSkus.has(code(raw.sku ?? raw.article ?? raw.part_number ?? raw.oem_number))) {
      errors.push('Артикул належить видаленій картці. Виберіть активний товар або виправте артикул нового. Видалену картку не відновлено.')
    }
    return { ...review, candidates: product && !review.candidates.some(item => item.id === product.id) ? [...review.candidates, product] : review.candidates, validation_errors: errors }
  }
  previewRows(rows: Array<Record<string, unknown>>): AiInvoiceReview[] {
    const reviews = rows.map(row => this.preview(row))
    const seen = new Map<string, number[]>()
    rows.forEach((row,index) => {
      const sku = text(row.sku ?? row.article ?? row.part_number ?? row.oem_number)
      const keys = [/^\(?\d{1,2}\)?$/.test(sku) ? code(sku) : '', code(row.barcode ?? row.ean)]
      keys.forEach((key,kind) => { if (key) { const token = kind + ':' + key; seen.set(token, [...(seen.get(token) ?? []), index]) } })
    })
    for (const indexes of seen.values()) {
      if (indexes.length < 2) continue
      const selected = indexes.map(index => text(rows[index].match_choice) || reviews[index].product_id)
      if (selected.every(id => id && id !== 'new')) continue
      const identities = new Set(indexes.map(index => identity(reviews[index].source_name, invoiceBrand(rows[index]))))
      if (identities.size < 2) continue
      const message = 'Один код повторюється у різних товарів у рядках ' + indexes.map(index => index + 1).join(', ') + '. Виправте артикул / штрихкод або виберіть відповідні картки; товари не об’єднано.'
      for (const index of indexes) reviews[index].validation_errors = [...new Set([...(reviews[index].validation_errors ?? []), message])]
    }
    return reviews
  }
  resolve(raw: Record<string, unknown>): AiInvoiceReview {
    const review = this.preview(raw), choice = text(raw.match_choice)
    if (review.validation_errors?.length) throw new Error(`«${review.source_name}»: ${review.validation_errors.join(' ')}`)
    if (choice && choice !== 'new') {
      const product = this.products.get(choice)!
      return { ...review, status: 'matched', product_id: product.id, name: product.name, brand: product.brand ?? '' }
    }
    if (review.status === 'review' && choice !== 'new') throw new Error(`«${review.source_name}»: ${review.reason}. Відкрийте перевірку накладної. Нові картки не створено.`)
    return choice === 'new' && review.status !== 'matched' ? { ...review, status: 'new', product_id: null } : review
  }
}
