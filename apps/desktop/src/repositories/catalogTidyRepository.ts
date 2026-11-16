import { createHash, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { CatalogCleanupRepository } from './catalogCleanupRepository'
import { LocalCatalogRepository } from './catalogRepository'

import {
  categoryNameKey, isGarbageName, learnCategoryRules, looksLikeLostThousands, needsRounding, roundRetailUp, tidyName,
} from './catalogTidyRules'

/**
 * «Навести порядок» у каталозі однією кнопкою на крок (рішення власника 15.11.2026).
 *
 * Кожен крок спершу показує, що саме зміниться, і виконується лише якщо каталог з того
 * часу не змінився. Запис іде звичайним збереженням картки та наявним механізмом
 * об'єднання, тому зміни потрапляють на сервер, а не лише в локальну базу.
 * Залишки цей клас не редагує: при об'єднанні вони складаються механізмом об'єднання.
 */
export type TidyStep = 'duplicates' | 'sku' | 'prices' | 'names' | 'garbage' | 'categories'
export const TIDY_STEPS: readonly TidyStep[] = ['duplicates', 'sku', 'prices', 'names', 'garbage', 'categories']
export interface TidyExample { name: string; before: string; after: string }
export interface TidyStepPlan { step: TidyStep; count: number; fingerprint: string; examples: TidyExample[] }
export interface TidyPlan {
  steps: TidyStepPlan[]
  /** Те, що власник вирішив не виправляти автоматично: лише для відома. */
  info: { lost_thousands: number; zero_or_below_cost: number; uncategorized_left: number; manual_duplicate_groups: number; garbage_kept: number }
}
export interface TidyResult { step: TidyStep; changed: number; skipped: Array<{ name: string; reason: string }> }
export interface TidyApplyInput { tenant_id: string; step: TidyStep; operation_id: string; fingerprint: string }

type Row = Record<string, any>
interface ProductRow { id: string; name: string; sku: string; category_id: string | null; purchase_price: number; retail_price: number; qty_on_hand: number }
interface CategoryRow { id: string; name: string }
type Item =
  | { kind: 'price'; id: string; name: string; from: number; to: number }
  | { kind: 'name'; id: string; from: string; to: string }
  | { kind: 'delete'; id: string; name: string }
  | { kind: 'category'; id: string; name: string; category_id: string; category: string }
  | { kind: 'category-delete'; id: string; name: string; reason: string }
  | { kind: 'merge'; target_id: string; source_ids: string[]; name: string; cards: number }
  | { kind: 'sku'; id: string; name: string; sku: string; fingerprint: string; evidence: string }

const EXAMPLES = 12
const money = (kopecks: number) => (kopecks / 100).toFixed(2).replace('.', ',') + ' грн'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('|').pop()!.slice(0, 300)
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"'
/** Таблиці-довідники картки: посилання з них не є історією товару. */
const METADATA_TABLES = new Set(['product_barcodes', 'product_aliases', 'product_cross_numbers'])

export class CatalogTidyRepository {
  private readonly catalog: LocalCatalogRepository

  constructor(private readonly db: LocalDatabase, private readonly cleanup: CatalogCleanupRepository) {
    this.catalog = new LocalCatalogRepository(db)
  }

  plan(tenantId: string): TidyPlan {
    return this.db.readSnapshot(() => {
      const built = this.build(tenantId)
      return {
        steps: TIDY_STEPS.map(step => ({ step, count: built.items[step].length, fingerprint: digest([step, built.items[step]]), examples: built.items[step].slice(0, EXAMPLES).map(example) })),
        info: built.info,
      }
    })
  }

  /**
   * Перевіряє право, номер операції та свіжість переліку і повертає роботу по одній картці.
   * Кожна картка — окрема транзакція: уже зроблене зберігається, збій однієї не скасовує решту,
   * а викликач може робити паузи між картками, щоб вікно програми не завмирало. Повтор після
   * обриву безпечний: виконане вже не потрапляє в наступний перелік.
   */
  begin(input: TidyApplyInput, userId: string): { total: number; step: (index: number) => void; finish: () => TidyResult } {
    if (!TIDY_STEPS.includes(input.step)) throw new Error('Невідомий крок наведення порядку')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operation_id) || !/^[a-f0-9]{64}$/.test(input.fingerprint))
      throw new Error('Потрібні свіжий перелік змін і номер операції')
    this.assertOwner(userId, input.tenant_id)
    const items = this.db.readSnapshot(() => this.build(input.tenant_id).items[input.step])
    if (digest([input.step, items]) !== input.fingerprint) throw new Error('Каталог змінився після показу переліку. Оновіть перелік і перевірте його ще раз.')
    const result: TidyResult = { step: input.step, changed: 0, skipped: [] }
    let finished = false
    return {
      total: items.length,
      step: index => {
        const item = items[index]
        if (!item || finished) return
        try { this.db.transaction(() => this.applyItem(input, item, userId)); result.changed++ }
        catch (error) { result.skipped.push({ name: itemName(item), reason: messageOf(error) }) }
      },
      finish: () => {
        if (!finished) { finished = true; this.db.transaction(() => this.audit(input, userId, { changed: result.changed, skipped: result.skipped.length, total: items.length })) }
        return result
      },
    }
  }

  /** Увесь крок без пауз — для тестів і перевірок на копії бази. */
  apply(input: TidyApplyInput, userId: string): TidyResult {
    const run = this.begin(input, userId)
    for (let index = 0; index < run.total; index++) run.step(index)
    return run.finish()
  }

  private applyItem(input: TidyApplyInput, item: Item, userId: string): void {
    const save = (id: string, changes: Row) => {
      const row = this.db.prepare('SELECT sku,name FROM products WHERE tenant_id=? AND id=? AND deleted_at IS NULL').get(input.tenant_id, id) as { sku: string; name: string } | undefined
      if (!row) throw new Error('Картку вже видалено або об’єднано')
      this.catalog.saveProduct({ id, tenant_id: input.tenant_id, sku: row.sku, name: row.name, ...changes })
    }
    switch (item.kind) {
      case 'price': return save(item.id, { retail_price: item.to })
      case 'name': return save(item.id, { name: item.to })
      case 'category': return save(item.id, { category_id: item.category_id })
      case 'delete': this.catalog.deleteProduct(item.id, input.tenant_id); return
      case 'category-delete': this.catalog.deleteCategory(item.id, input.tenant_id); return
      case 'sku':
        this.cleanup.applySku({ tenant_id: input.tenant_id, operation_id: randomUUID(), product_id: item.id, sku: item.sku, preview_fingerprint: item.fingerprint, reason: item.evidence }, userId)
        return
      case 'merge': {
        const selection = { tenant_id: input.tenant_id, target_id: item.target_id, source_ids: item.source_ids, stock_review: 'pending' as const }
        const preview = this.cleanup.preview(selection)
        if (!preview.can_apply || preview.blockers.length) throw new Error(preview.blockers.join('; ') || 'Об’єднання недоступне')
        // Власник: ціна — більша з карток. Закупівельну теж беремо більшу, щоб правило
        // «не продавати нижче закупівлі» після об'єднання не стало слабшим.
        const retail = Math.max(...preview.products.map(row => Number(row.retail_price ?? 0)))
        const purchase = Math.max(...preview.products.map(row => Number(row.purchase_price ?? 0)))
        this.cleanup.apply({ ...selection, operation_id: randomUUID(), preview_fingerprint: preview.fingerprint, reason: 'Автоматичне об’єднання точних дублів: назви збігаються' }, userId)
        const target = this.db.prepare('SELECT sku,name,retail_price,purchase_price FROM products WHERE tenant_id=? AND id=?').get(input.tenant_id, item.target_id) as Row
        const nextRetail = needsRounding(retail, purchase) ? roundRetailUp(retail) : retail
        if (target.retail_price !== nextRetail || target.purchase_price !== purchase)
          this.catalog.saveProduct({ id: item.target_id, tenant_id: input.tenant_id, sku: target.sku, name: target.name, retail_price: nextRetail, purchase_price: purchase })
      }
    }
  }

  private build(tenantId: string): { items: Record<TidyStep, Item[]>; info: TidyPlan['info'] } {
    const products = this.db.prepare(`SELECT id,name,sku,category_id,purchase_price,retail_price,qty_on_hand FROM products
      WHERE tenant_id=? AND deleted_at IS NULL AND is_active=1 AND is_service=0 ORDER BY id`).all(tenantId) as unknown as ProductRow[]
    const categories = this.db.prepare('SELECT id,name FROM categories WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id').all(tenantId) as unknown as CategoryRow[]
    const categoryById = new Map(categories.map(row => [row.id, row]))
    const byId = new Map(products.map(row => [row.id, row]))

    const prices: Item[] = products.filter(row => needsRounding(row.retail_price, row.purchase_price))
      .map(row => ({ kind: 'price', id: row.id, name: row.name, from: row.retail_price, to: roundRetailUp(row.retail_price) }))
    const names: Item[] = products.filter(row => tidyName(row.name) !== row.name && tidyName(row.name))
      .map(row => ({ kind: 'name', id: row.id, from: row.name, to: tidyName(row.name) }))

    const garbageRows = products.filter(row => isGarbageName(row.name))
    const referenced = this.referencedProducts(garbageRows.filter(row => row.qty_on_hand === 0).map(row => row.id))
    const garbage: Item[] = garbageRows.filter(row => row.qty_on_hand === 0 && !referenced.has(row.id)).map(row => ({ kind: 'delete', id: row.id, name: row.name }))
    const deleting = new Set(garbage.map(item => (item as { id: string }).id))

    // Категорії: дублі назв зводимо до найбільшої, порожні прибираємо, товари без категорії розкладаємо.
    const categoryItems: Item[] = []
    const counts = new Map<string, number>()
    for (const row of products) if (row.category_id && categoryById.has(row.category_id)) counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1)
    const redirect = new Map<string, string>()
    const sameName = new Map<string, CategoryRow[]>()
    for (const row of categories) sameName.set(categoryNameKey(row.name), [...(sameName.get(categoryNameKey(row.name)) ?? []), row])
    for (const group of sameName.values()) {
      if (group.length < 2) continue
      const [keep, ...drop] = [...group].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      for (const row of drop) redirect.set(row.id, keep.id)
    }
    for (const row of products) {
      const target = row.category_id ? redirect.get(row.category_id) : undefined
      if (target) categoryItems.push({ kind: 'category', id: row.id, name: row.name, category_id: target, category: categoryById.get(target)!.name })
    }
    const suggest = learnCategoryRules(products.filter(row => row.category_id && categoryById.has(row.category_id) && !redirect.has(row.category_id)))
    let uncategorizedLeft = 0
    for (const row of products) {
      if ((row.category_id && categoryById.has(row.category_id)) || deleting.has(row.id)) continue
      const rule = suggest(row.name)
      if (rule && categoryById.has(rule.category_id)) categoryItems.push({ kind: 'category', id: row.id, name: row.name, category_id: rule.category_id, category: categoryById.get(rule.category_id)!.name })
      else uncategorizedLeft++
    }
    for (const [dropId, keepId] of redirect) categoryItems.push({ kind: 'category-delete', id: dropId, name: categoryById.get(dropId)!.name, reason: 'дубль категорії «' + categoryById.get(keepId)!.name + '»' })
    for (const row of categories) if (!redirect.has(row.id) && !(counts.get(row.id) ?? 0)) categoryItems.push({ kind: 'category-delete', id: row.id, name: row.name, reason: 'порожня категорія' })

    const scan = this.cleanup.scan(tenantId)
    const sure = scan.groups.filter(group => group.level === 'exact' && group.same_name)
    const duplicates: Item[] = sure.map(group => ({
      kind: 'merge', target_id: group.suggested_target_id, source_ids: group.product_ids.filter(id => id !== group.suggested_target_id),
      name: byId.get(group.suggested_target_id)?.name ?? group.suggested_target_id, cards: group.product_ids.length,
    }))
    const merging = new Set(sure.flatMap(group => group.product_ids))
    // Артикул картки, яку зараз об'єднають, переноситься після об'єднання наступним оновленням переліку.
    const sku: Item[] = scan.sku_suggestions.filter(row => !row.blocked && !merging.has(row.product_id) && byId.has(row.product_id))
      .map(row => ({ kind: 'sku', id: row.product_id, name: byId.get(row.product_id)!.name, sku: row.sku, fingerprint: row.preview_fingerprint, evidence: row.evidence }))

    return {
      items: { duplicates, sku, prices, names, garbage, categories: categoryItems },
      info: {
        lost_thousands: products.filter(row => looksLikeLostThousands(row.retail_price, row.purchase_price)).length,
        zero_or_below_cost: products.filter(row => !looksLikeLostThousands(row.retail_price, row.purchase_price) && (row.retail_price === 0 || row.retail_price < row.purchase_price)).length,
        uncategorized_left: uncategorizedLeft,
        manual_duplicate_groups: scan.groups.filter(group => group.level === 'exact' && !group.same_name).length,
        garbage_kept: garbageRows.length - garbage.length,
      },
    }
  }

  /** Картка з будь-яким записом у документах лишається: видаляється лише те, чого ніде немає. */
  private referencedProducts(ids: string[]): Set<string> {
    const found = new Set<string>()
    if (!ids.length) return found
    const placeholders = ids.map(() => '?').join(',')
    const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    for (const table of tables) {
      if (table.name === 'products' || METADATA_TABLES.has(table.name)) continue
      const columns = this.db.prepare('PRAGMA table_info(' + quote(table.name) + ')').all() as { name: string }[]
      for (const column of columns.filter(item => /(^|_)product_id$/.test(item.name))) {
        const rows = this.db.prepare('SELECT DISTINCT ' + quote(column.name) + ' AS id FROM ' + quote(table.name) + ' WHERE ' + quote(column.name) + ' IN (' + placeholders + ')').all(...ids) as { id: string }[]
        for (const row of rows) found.add(row.id)
      }
    }
    return found
  }

  private assertOwner(userId: string, tenantId: string) {
    const user = this.db.prepare('SELECT role,is_active,deleted_at FROM staff_users WHERE id=? AND tenant_id=?').get(userId, tenantId) as Row | undefined
    if (!user || !user.is_active || user.deleted_at || !['owner', 'admin'].includes(user.role)) throw new Error('Наведення порядку в каталозі доступне лише власнику або адміністратору')
  }

  private audit(input: TidyApplyInput, userId: string, outcome: Row) {
    this.db.prepare(`INSERT INTO audit_log(event_id,tenant_id,device_id,user_id,action,entity_type,entity_id,before_json,after_json,created_at)
      VALUES(?,?,?,?,'catalog.tidy','catalog',?,?,?,?)`).run(randomUUID(), input.tenant_id, this.db.deviceId, userId, input.step,
      JSON.stringify({ fingerprint: input.fingerprint }), JSON.stringify({ ...outcome, operation_id: input.operation_id }), new Date().toISOString())
  }
}

function example(item: Item): TidyExample {
  switch (item.kind) {
    case 'price': return { name: item.name, before: money(item.from), after: money(item.to) }
    case 'name': return { name: item.to, before: JSON.stringify(item.from), after: JSON.stringify(item.to) }
    case 'delete': return { name: item.name, before: 'картка без залишку й без документів', after: 'видалити' }
    case 'category': return { name: item.name, before: 'без категорії або дубль категорії', after: item.category }
    case 'category-delete': return { name: 'Категорія «' + item.name + '»', before: item.reason, after: 'прибрати' }
    case 'merge': return { name: item.name, before: item.cards + ' картки з однаковою назвою', after: 'одна картка, більша ціна, залишок сумою' }
    case 'sku': return { name: item.name, before: 'артикул не заповнено', after: item.sku }
  }
}

function itemName(item: Item): string {
  return item.kind === 'name' ? item.from : item.name
}
