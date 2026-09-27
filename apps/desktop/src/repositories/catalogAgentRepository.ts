import { createHash, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { LocalCatalogRepository } from './catalogRepository'
import { idempotentMutation } from './idempotentMutation'

export type AgentChange = { product_id: string; fingerprint: string; changes?: Record<string, unknown>; primary_id?: string; primary_fingerprint?: string }
export const normalizeAgentCode = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
export const missingAgentSku = (sku: unknown) => !String(sku ?? '').trim() || /^AUTO[-_]/i.test(String(sku))
export function catalogCodeFromName(name: string, sku: string): boolean {
  const code = sku.toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
  if (code.length < 4 || !/\d/.test(code) || /^(?:\d+(?:W\d+|ML|L|KG|MM|CM|V|W|AH|A|H)|(?:VAZ|ВАЗ|GAZ|ГАЗ|ЗАЗ|ЗИЛ)\d+)$/i.test(code)) return false
  const pattern = [...code].join('[\\s./-]*')
  return new RegExp('(^|[^\\p{L}\\p{N}])' + pattern + '($|[^\\p{L}\\p{N}])', 'iu').test(name)
}
export function skuFromName(name: string): string | null {
  const explicit = name.match(/(?:арт(?:икул)?[.:№ ]+|кат(?:аложний)?[. №]+)([A-Z0-9][A-Z0-9/.-]{2,30})/i)?.[1]
  if (explicit && catalogCodeFromName(name, explicit)) return explicit
  const tokens = name.match(/[A-Z0-9][A-Z0-9/.-]*[A-Z0-9]/gi) ?? []
  const candidates = tokens.filter(t => /[A-Z]/i.test(t) && /\d/.test(t) && t.length >= 4
    && catalogCodeFromName(name, t))
  return candidates.length === 1 ? candidates[0] : null
}
export function preservesTechnicalName(before: string, after: string) {
  const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map(value => value.replace(',', '.'))
  if (JSON.stringify(numbers(before)) !== JSON.stringify(numbers(after))) return false
  const units = (s: string) => Array.from(s.matchAll(/(\d+(?:[.,]\d+)?)\s*(мл|ml|мм|mm|см|cm|кг|kg|шт|pcs|л|l|м|m|г|g|вт|w|в|v|ah|ач)(?![\p{L}\p{N}])/giu), match => {
    const aliases: Record<string,string> = {ml:'мл',mm:'мм',cm:'см',kg:'кг',pcs:'шт',l:'л',m:'м',g:'г',w:'вт',v:'в',ah:'ач'}
    const unit=match[2].toLowerCase()
    return match[1].replace(',', '.') + ':' + (aliases[unit] ?? unit)
  })
  if (JSON.stringify(units(before)) !== JSON.stringify(units(after))) return false
  const codes = before.match(/\b[A-Z0-9][A-Z0-9/.-]*[A-Z0-9]\b/gi) ?? []
  const compact = normalizeAgentCode(after)
  return codes.filter(x => /[a-z]/i.test(x) && /\d/.test(x)).every(x => compact.includes(normalizeAgentCode(x)))
}
export function agentFingerprint(p: Record<string, any>) {
  return createHash('sha256').update(JSON.stringify([p.id, p.name, p.sku, p.barcode, p.category_id, p.brand_id, p.unit,
    p.purchase_price, p.retail_price, p.deleted_at ?? null])).digest('hex')
}
export function gridAgentPrice(purchase: number, settings: any): number | null {
  const rule = (Array.isArray(settings.markup_rules) ? settings.markup_rules : []).find((r: any) => purchase >= Number(r.minPrice) && purchase < Number(r.maxPrice))
  if (!rule || purchase <= 0 || !Number.isFinite(Number(rule.markupPct))) return null
  let price = Math.round(purchase * (1 + Number(rule.markupPct) / 100))
  {
    const step = Math.max(50, settings.price_rounding_enabled ? Number(settings.price_rounding_step) || 100 : 100)
    price = (settings.price_rounding_dir === 'up' ? Math.ceil(price / step) : settings.price_rounding_dir === 'down' ? Math.floor(price / step) : Math.round(price / step)) * step
  }
  return Number.isSafeInteger(price) && price > 0 ? price : null
}

export class CatalogAgentRepository {
  private catalog: LocalCatalogRepository | null = null
  private writer() { return this.catalog ??= new LocalCatalogRepository(this.db) }
  private settings(): any {
    const row = this.db.prepare("SELECT value_json FROM app_meta WHERE key='shop_settings'").get() as any
    return row ? JSON.parse(row.value_json) : {}
  }
  constructor(private db: LocalDatabase) {}
  private product(id: string) {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, DEFAULT_TENANT_ID) as any
    if (!row) throw new Error('Товар відсутній або вже видалений. Оновіть перевірку.')
    return row
  }
  private archiveBlock(product: any): string | null {
    if (Number(product.qty_on_hand) !== 0) return 'Є залишок: видалення заблоковане'
    // Any document/reference, even historical, protects the card. Names come
    // from SQLite schema metadata, not renderer or AI text.
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as any[]
    const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"'
    for (const { name } of tables) {
      if (['product_barcodes', 'product_aliases', 'product_cross_numbers'].includes(name)) continue
      const columns = this.db.prepare('PRAGMA table_info(' + quote(name) + ')').all() as any[]
      for (const column of columns.filter(c => /(^|_)product_id$/.test(c.name))) {
        if (this.db.prepare('SELECT 1 FROM ' + quote(name) + ' WHERE ' + quote(column.name) + ' = ? LIMIT 1').get(product.id)) return 'Є документи, резерви або історія: потрібне окреме злиття'
      }
    }
    return null
  }
  scan(input: { min_markup?: number } = {}) {
    const minMarkup = Number(input.min_markup ?? 15)
    if (!Number.isFinite(minMarkup) || minMarkup < 0 || minMarkup > 1000) throw new Error('Поріг націнки: від 0 до 1000%')
    const products = this.db.prepare("SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND p.is_service=0 ORDER BY p.name, p.id").all(DEFAULT_TENANT_ID) as any[]
    const categories = this.db.prepare('SELECT id,name FROM categories WHERE tenant_id=? AND deleted_at IS NULL ORDER BY name').all(DEFAULT_TENANT_ID)
    const settings = this.settings()
    const issues: any[] = []
    const usedSkus = new Set(products.filter(p => !missingAgentSku(p.sku)).map(p => normalizeAgentCode(p.sku)))
    const add = (p: any, kind: string, reason: string, changes: any = {}) => issues.push({ id: p.id + ':' + kind, product_id: p.id, fingerprint: agentFingerprint(p), kind, name: p.name, sku: p.sku, reason, changes,
      before: { name: p.name, sku: p.sku, category_id: p.category_id, retail_price: p.retail_price }, qty_on_hand: Number(p.qty_on_hand) })
    for (const p of products) {
      const candidate = missingAgentSku(p.sku) ? skuFromName(p.name) : null
      if (candidate) add(p, 'sku', usedSkus.has(normalizeAgentCode(candidate)) ? 'Артикул із назви вже використовується — перевірте дубль' : 'Каталожний номер явно присутній у назві', usedSkus.has(normalizeAgentCode(candidate)) ? {} : { sku: candidate })
      if (!p.category_id) add(p, 'category', 'Категорію не вказано — запустіть AI-перевірку назв і папок')
      if (/[ыэъё]/i.test(p.name)) add(p, 'name', 'Можлива російська назва — AI запропонує український переклад')
      const purchase = Number(p.purchase_price), retail = Number(p.retail_price)
      if (purchase <= 0) add(p, 'price', 'Закупівельна ціна відсутня: націнку перевірити неможливо')
      else if ((retail - purchase) / purchase * 100 < minMarkup) {
        const suggested = gridAgentPrice(purchase, settings)
        add(p, 'price', 'Націнка ' + (((retail - purchase) / purchase) * 100).toFixed(1) + '% — нижче порога ' + minMarkup + '%. Це підозра, не доведена помилка.' + (suggested ? ' Пропозиція за вашою таблицею.' : ' Для цієї ціни немає правила в таблиці.'), suggested && suggested > retail ? { retail_price: suggested } : {})
      }
    }
    const groups = new Map<string, any[]>()
    for (const p of products) {
      const keys = ['name:' + p.name.trim().toLocaleLowerCase('uk').replace(/\s+/g, ' ') + ':' + p.unit + ':' + (p.brand_id ?? '')]
      if (!missingAgentSku(p.sku)) keys.push('sku:' + normalizeAgentCode(p.sku))
      if (p.barcode) keys.push('barcode:' + p.barcode.trim())
      for (const key of keys) { const group = groups.get(key) ?? []; group.push(p); groups.set(key, group) }
    }
    const seen = new Set<string>()
    for (const group of groups.values()) if (group.length > 1) {
      group.sort((a, b) => Number(b.qty_on_hand) - Number(a.qty_on_hand) || a.id.localeCompare(b.id))
      const primary = group[0]
      for (const duplicate of group.slice(1)) {
        const key = [primary.id, duplicate.id].sort().join(':')
        if (seen.has(key)) continue
        seen.add(key)
        const blocked = this.archiveBlock(duplicate) || this.archiveIdentityBlock(duplicate, primary)
        issues.push({ id: key, product_id: duplicate.id, fingerprint: agentFingerprint(duplicate), kind: 'duplicate', name: duplicate.name, sku: duplicate.sku, primary_id: primary.id,
          primary_fingerprint: agentFingerprint(primary), primary_name: primary.name, primary_sku: primary.sku, qty_on_hand: Number(duplicate.qty_on_hand),
          reason: blocked ?? 'Порожня картка без документів. Перевірте тотожність перед вилученням.', blocked, changes: {} })
      }
    }
    return { products: products.map(p => ({ id: p.id, name: p.name, sku: p.sku, brand: p.brand_name ?? '', category_id: p.category_id, fingerprint: agentFingerprint(p) })), categories, issues, total: products.length }
  }
  private archiveIdentityBlock(p: any, primary: any): string | null {
    if (!primary.is_active) return 'Основна картка неактивна — виберіть чинний товар'
    if (p.unit !== primary.unit || p.brand_id !== primary.brand_id) return 'Різні одиниці або бренди — не можна видаляти як дубль'
    const sameName = p.name.trim().toLocaleLowerCase('uk').replace(/\s+/g, ' ') === primary.name.trim().toLocaleLowerCase('uk').replace(/\s+/g, ' ')
    const sameBarcode = p.barcode && p.barcode === primary.barcode
    const sameSku = !missingAgentSku(p.sku) && normalizeAgentCode(p.sku) === normalizeAgentCode(primary.sku)
    if (!sameName && !sameBarcode && !sameSku) return 'Тотожність не підтверджена'
    for (const field of ['notes', 'photo_url', 'storage_bin', 'category_id']) if (p[field] && p[field] !== primary[field]) return 'У картці є окремі дані (' + field + ') — потрібне злиття'
    if (p.specs_json && !['{}', 'null'].includes(p.specs_json) && p.specs_json !== primary.specs_json) return 'Є окремі характеристики — потрібне злиття'
    if (p.requires_core_return !== primary.requires_core_return || p.core_deposit_amount !== primary.core_deposit_amount) return 'Різні умови повернення тари — потрібна ручна перевірка'
    const codes = this.db.prepare('SELECT barcode FROM product_barcodes WHERE product_id=? AND deleted_at IS NULL').all(p.id) as any[]
    const primaryCodes = new Set([primary.barcode, ...(this.db.prepare('SELECT barcode FROM product_barcodes WHERE product_id=? AND deleted_at IS NULL').all(primary.id) as any[]).map(r => r.barcode)])
    if ([p.barcode, ...codes.map(r => r.barcode)].filter(Boolean).some(code => !primaryCodes.has(code))) return 'У дубля є окремий штрихкод — потрібне злиття, а не видалення'
    if (!missingAgentSku(p.sku) && !sameSku) return 'Різні артикули — потрібна ручна перевірка'
    for (const table of ['product_aliases', 'product_cross_numbers']) if (this.db.prepare('SELECT 1 FROM ' + table + ' WHERE product_id=? AND deleted_at IS NULL LIMIT 1').get(p.id)) return 'У картці є додаткові номери або назви — потрібне злиття'
    return null
  }
  apply(input: { operation_id: string; items: AgentChange[] }, userId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(input?.operation_id) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new Error('Оберіть від 1 до 100 змін для підтвердження')
    const ids = input.items.map(x => x.product_id)
    if (new Set(ids).size !== ids.length || input.items.some(x => x.primary_id && ids.includes(x.primary_id))) throw new Error('Один товар не можна одночасно змінювати та видаляти. Застосуйте дії окремо.')
    return idempotentMutation(this.db, 'catalog-agent:' + DEFAULT_TENANT_ID, input.operation_id, input, () => {
      for (const action of input.items) {
        const before = this.product(action.product_id)
        if (agentFingerprint(before) !== action.fingerprint) throw new Error('Картку вже змінено: ' + before.name + '. Оновіть перевірку.')
        if (action.primary_id) {
          const primary = this.product(action.primary_id)
          if (agentFingerprint(primary) !== action.primary_fingerprint) throw new Error('Основну картку змінено. Оновіть перевірку.')
          const blocked = this.archiveBlock(before) || this.archiveIdentityBlock(before, primary)
          if (blocked) throw new Error(blocked + ': ' + before.name)
          this.writer().deleteProduct(before.id)
        } else {
          const changes = action.changes ?? {}
          if (!Object.keys(changes).length || Object.keys(changes).some(k => !['name', 'sku', 'category_id', 'retail_price'].includes(k))) throw new Error('Агенту заборонено змінювати залишки, закупку, штрихкоди та інші поля')
          if (changes.name !== undefined && before.brand_id) {
            const brand = this.db.prepare('SELECT name FROM brands WHERE id=? AND tenant_id=?').get(before.brand_id, DEFAULT_TENANT_ID) as any
            if (brand?.name && before.name.toLowerCase().includes(brand.name.toLowerCase()) && !String(changes.name).toLowerCase().includes(brand.name.toLowerCase())) throw new Error('Переклад не повинен змінювати бренд')
          }
          if (changes.name !== undefined && (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 500 || !preservesTechnicalName(before.name, changes.name))) throw new Error('Переклад змінює технічні номери або розміри')
          if (changes.sku !== undefined) {
            const code = normalizeAgentCode(changes.sku)
            if (!missingAgentSku(before.sku) || typeof changes.sku !== 'string' || !code || changes.sku.length > 80 || !catalogCodeFromName(before.name, changes.sku)) throw new Error('Артикул можна взяти лише з назви та лише замість порожнього/службового')
            const other = (this.db.prepare('SELECT id,sku FROM products WHERE tenant_id=? AND deleted_at IS NULL AND id<>?').all(DEFAULT_TENANT_ID, before.id) as any[]).find(p => normalizeAgentCode(p.sku) === code)
            if (other) throw new Error('Артикул уже належить іншому товару. Перевірте дубль.')
          }
          if (changes.category_id !== undefined && !this.db.prepare('SELECT 1 FROM categories WHERE id=? AND tenant_id=? AND deleted_at IS NULL').get(String(changes.category_id), DEFAULT_TENANT_ID)) throw new Error('Категорію не знайдено')
          if (changes.retail_price !== undefined && (typeof changes.retail_price !== 'number' || !Number.isSafeInteger(changes.retail_price) || changes.retail_price <= 0 || changes.retail_price !== gridAgentPrice(before.purchase_price, this.settings()))) throw new Error('Ціна має відповідати поточній таблиці націнки')
          let specs = {}; try { specs = JSON.parse(before.specs_json || '{}') } catch { throw new Error('Специфікація товару пошкоджена. Спочатку перевірте картку.') }
          this.writer().saveProduct({ ...before, ...changes, is_active: Boolean(before.is_active), is_service: Boolean(before.is_service), is_favorite: Boolean(before.is_favorite), requires_core_return: Boolean(before.requires_core_return), specs })
        }
        this.db.prepare(`INSERT INTO audit_log (event_id,tenant_id,device_id,user_id,action,entity_type,entity_id,after_json,created_at) VALUES (?,?,?,?,?,'product',?,?,?)`).run(randomUUID(), DEFAULT_TENANT_ID, this.db.deviceId, userId, 'catalog_agent.' + (action.primary_id ? 'archive' : 'update'), before.id, JSON.stringify({ before, changes: action.changes ?? null, primary_id: action.primary_id ?? null }), new Date().toISOString())
      }
      return { updated: input.items.length }
    })
  }
}
