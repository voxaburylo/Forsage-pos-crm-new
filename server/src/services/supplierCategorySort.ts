import { pool } from '../db/pg.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { ClaudeClient, isClaudeModel, type ClaudeUsage } from './aiClaude.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'
import { usageCostUsd } from './aiJobService.js'
import { categoryIndex, ruleCategoryId } from './categoryByName.js'
import { agreedCategory, categoryKey, categoryOptions, parseSortReply, sortLine, sortPrompt, type CategoryOption } from './supplierCategoryKey.js'

/**
 * Розкладка товарів постачальників по наших категоріях (26.11.2026). Увімкнена — працює сама щохвилини, поки є товари
 * без категорії, і далі розкладає все, що приходить по API: відомий вид лягає в категорію одразу (правило з бази),
 * новий вид помічник вирішує двома незалежними відповідями (категорія ставиться лише коли обидві збіглись).
 * Категорію, поставлену людиною ('manual'), і розкладене програмою за нашими картками ('auto') не чіпаємо.
 */
export const SORT_PAGE = 3000, SORT_KINDS = 60, SORT_CHUNKS = 4, SORT_RUN_MS = 50_000
export type SortModel = { complete: (budget: AiExecutionBudget, input: { system: string; text: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }) => Promise<ClaudeUsage & { text: string; truncated: boolean }> }
type Offer = { connection_id: string; external_id: string; name: string; category_name: string | null }
type Rule = { category_id: string | null; wait: boolean }

export async function sortStatus(tenantId: string) {
  const [state, counts] = await Promise.all([
    pool.query('SELECT enabled, cost_usd, last_error, updated_at FROM supplier_category_sort WHERE tenant_id = $1', [tenantId]),
    pool.query(`SELECT count(*) FILTER (WHERE category_id IS NULL AND category_source IS NULL)::int AS waiting,
                       count(*) FILTER (WHERE category_source = 'ai')::int AS sorted, count(*) FILTER (WHERE category_source = 'ai_none')::int AS unsure, count(*) FILTER (WHERE category_source = 'ai_wait')::int AS waiting_new,
                       count(*) FILTER (WHERE category_id IS NOT NULL)::int AS with_category, count(*)::int AS total
                  FROM supplier_offers WHERE tenant_id = $1`, [tenantId]),
  ])
  const row = state.rows[0]
  const fresh = await (await import('./supplierCategoryNew.js')).newCategoryStatus(tenantId)
  return { ...fresh, enabled: Boolean(row?.enabled), cost_usd: Number(row?.cost_usd ?? 0), last_error: (row?.last_error as string | null) ?? null, ...(counts.rows[0] as { waiting: number; sorted: number; unsure: number; waiting_new: number; with_category: number; total: number }) }
}

export async function setSortEnabled(tenantId: string, userId: string, enabled: boolean) {
  await pool.query(`INSERT INTO supplier_category_sort (tenant_id, enabled, started_by) VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, started_by = EXCLUDED.started_by, last_error = NULL, updated_at = now()`, [tenantId, enabled, userId])
  return sortStatus(tenantId)
}

/** «Повернути як було»: зняти все, що поставив помічник, і забути його правила. Ручні й старі автоматичні категорії лишаються. */
export async function undoSort(tenantId: string, userId: string) {
  await pool.query(`INSERT INTO supplier_category_sort (tenant_id, enabled, started_by) VALUES ($1, false, $2)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = false, last_error = NULL, updated_at = now()`, [tenantId, userId])
  await pool.query("UPDATE supplier_offers SET category_id = NULL, category_source = NULL, updated_at = now() WHERE tenant_id = $1 AND category_source IN ('ai', 'ai_none', 'ai_wait')", [tenantId])
  await pool.query('DELETE FROM supplier_category_rules WHERE tenant_id = $1', [tenantId])
  return sortStatus(tenantId)
}

/** Одна сторінка: відомі види — у категорії одразу; для невідомих — запит до помічника (двома голосами), правила зберігаються. */
export async function sortPage(tenantId: string, options: readonly CategoryOption[], model: SortModel, budget: AiExecutionBudget, helper: SortModel = model): Promise<{ offers: number; placed: number; usage: ClaudeUsage[]; asked: number; byRule?: number }> {
  const loaded = (await pool.query(`SELECT connection_id::text AS connection_id, external_id, name, category_name FROM supplier_offers
     WHERE tenant_id = $1 AND category_id IS NULL AND category_source IS NULL ORDER BY connection_id, external_id LIMIT $2`, [tenantId, SORT_PAGE])).rows as Offer[]
  if (!loaded.length) return { offers: 0, placed: 0, usage: [], asked: 0 }
  const all = loaded.map(offer => ({ offer, key: categoryKey(offer) }))
  const keys = [...new Set(all.map(entry => entry.key).filter((key): key is string => Boolean(key)))]
  const rules = new Map<string, Rule>((await pool.query('SELECT key, category_id::text AS category_id, new_name FROM supplier_category_rules WHERE tenant_id = $1 AND key = ANY($2)', [tenantId, keys])).rows
    .map((row: { key: string; category_id: string | null; new_name: string | null }) => [row.key, { category_id: row.category_id, wait: Boolean(row.new_name) }]))
  // 26.11.2026 (слово власника): товар зі зрозумілою назвою розкладає алгоритм, без ШІ й без витрат (categoryByName).
  // Уже вивчене правило для виду (воно точніше: «Повітряні фільтри», а не просто «Фільтри») має перевагу; до ШІ доходить
  // лише те, чого немає ні там, ні там.
  const index = categoryIndex(options)
  const direct: Array<{ connection_id: string; external_id: string; category_id: string; source: string }> = []
  const keyed: typeof all = []
  for (const entry of all) {
    const id = entry.key && rules.has(entry.key) ? null : ruleCategoryId(entry.offer.name, index)
    if (id) direct.push({ connection_id: entry.offer.connection_id, external_id: entry.offer.external_id, category_id: id, source: 'ai' }); else keyed.push(entry)
  }
  for (let at = 0; at < direct.length; at += 1000) {
    await pool.query(`UPDATE supplier_offers o SET category_id = x.category_id, category_source = x.source, updated_at = now()
        FROM jsonb_to_recordset($2::jsonb) AS x(connection_id uuid, external_id text, category_id uuid, source text)
       WHERE o.tenant_id = $1 AND o.connection_id = x.connection_id AND o.external_id = x.external_id AND o.category_id IS NULL AND o.category_source IS NULL`,
      [tenantId, JSON.stringify(direct.slice(at, at + 1000))])
  }
  // Невідомі види: найчастіші першими — так за одну хвилину розкладається найбільше товарів.
  const unknown = new Map<string, string[]>()
  for (const { offer, key } of keyed) if (key && !rules.has(key)) { const samples = unknown.get(key) ?? []; samples.push(offer.name); unknown.set(key, samples) }
  const ask = [...unknown.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, SORT_KINDS * SORT_CHUNKS)
  const usage: ClaudeUsage[] = []
  const valid = new Set(options.map(option => option.id))
  const chunks: Array<Array<[string, string[]]>> = []
  for (let index = 0; index < ask.length; index += SORT_KINDS) chunks.push(ask.slice(index, index + SORT_KINDS))
  await Promise.all(chunks.map(async chunk => {
    const text = chunk.map(([key, samples], index) => sortLine(index + 1, key, samples)).join('\n')
    // Два голоси. Рішення власника 26.11.2026: обидва дає основна модель (Sonnet); окрему помічницю можна передати параметром helper.
    // Категорія ставиться лише там, де дві РІЗНІ моделі зійшлись; розійшлись — «не певен», як і раніше.
    const votes = await Promise.all([model, helper].map(async voter => {
      const answer = await voter.complete(budget, { system: sortPrompt(options), text, maxTokens: 4000, effort: voter === model ? 'low' : 'medium' })
      usage.push(answer)
      return parseSortReply(answer.text, chunk.length, options.length)
    }))
    const found = chunk.map(([key, samples], index) => {
      const pick = agreedCategory(votes[0].get(index + 1), votes[1].get(index + 1))
      const id = pick.c > 0 ? options[pick.c - 1].id : null
      // Нова категорія вже є з такою самою назвою (регістр і пробіли не рахуємо) — це наявна, а не нова.
      const same = pick.c === -1 ? options.find(option => option.path.split(' › ').at(-1)!.toLocaleLowerCase('uk-UA') === pick.name.toLocaleLowerCase('uk-UA')) : undefined
      return { key, category_id: same?.id ?? (id && valid.has(id) ? id : null), new_name: pick.c === -1 && !same ? pick.name : null, sample: samples[0].slice(0, 300) }
    })
    await pool.query(`INSERT INTO supplier_category_rules (tenant_id, key, category_id, new_name, sample)
       SELECT $1, x.key, x.category_id, x.new_name, x.sample FROM jsonb_to_recordset($2::jsonb) AS x(key text, category_id uuid, new_name text, sample text) ON CONFLICT (tenant_id, key) DO NOTHING`, [tenantId, JSON.stringify(found)])
    for (const row of found) rules.set(row.key, { category_id: row.category_id, wait: Boolean(row.new_name) })
  }))
  // Товар без виду (назва з бренду чи коду) — «не певен». Товар із видом, до якого ще не дійшла черга, чекає наступної хвилини.
  const changes = keyed.filter(entry => !entry.key || rules.has(entry.key)).map(({ offer, key }) => {
    const rule = key ? rules.get(key) : undefined
    // 'ai_wait' — для виду потрібна нова категорія: товар чекає, поки каса її створить.
    return { connection_id: offer.connection_id, external_id: offer.external_id, category_id: rule?.category_id ?? null, source: rule?.category_id ? 'ai' : rule?.wait ? 'ai_wait' : 'ai_none' }
  })
  for (let index = 0; index < changes.length; index += 1000) {
    await pool.query(`UPDATE supplier_offers o SET category_id = x.category_id, category_source = x.source, updated_at = now()
        FROM jsonb_to_recordset($2::jsonb) AS x(connection_id uuid, external_id text, category_id uuid, source text)
       WHERE o.tenant_id = $1 AND o.connection_id = x.connection_id AND o.external_id = x.external_id AND o.category_id IS NULL AND o.category_source IS NULL`,
      [tenantId, JSON.stringify(changes.slice(index, index + 1000))])
  }
  return { offers: loaded.length, placed: direct.length + changes.filter(change => change.category_id).length, usage, asked: ask.length, byRule: direct.length }
}

/** Пробудження від планувальника (те саме, що будить фонові задачі). Нічого не ввімкнено чи нема чого розкладати — повертається одразу. */
export async function runCategorySortStep(deps: { model?: (apiKey: string, model: string) => SortModel; now?: () => number } = {}): Promise<{ shops: number; placed: number; errors: number }> {
  const now = deps.now ?? Date.now, deadline = now() + SORT_RUN_MS
  const { rows: shops } = await pool.query('SELECT tenant_id::text AS tenant_id, started_by FROM supplier_category_sort WHERE enabled LIMIT 3')
  let placed = 0, errors = 0
  for (const shop of shops as Array<{ tenant_id: string; started_by: string | null }>) {
    const { getAiConfig, recordAiUsage } = await import('./aiService.js')
    const config = await getAiConfig(shop.tenant_id).catch(() => null)
    if (!config?.enabled || !config.apiKey) {
      await pool.query('UPDATE supplier_category_sort SET last_error = $2, updated_at = now() WHERE tenant_id = $1', [shop.tenant_id, 'Помічник вимкнений або немає ключа Anthropic (Налаштування → ШІ).'])
      continue
    }
    const { categoryRows } = await import('./siteCatalogCategories.js')
    const options = categoryOptions(await categoryRows(shop.tenant_id))
    if (!options.length) continue
    const model = deps.model ? deps.model(config.apiKey, config.model) : new ClaudeClient(config.apiKey, isClaudeModel(config.model) ? config.model : 'claude-sonnet-5-5')
    const fresh = await import('./supplierCategoryNew.js')
    // Категорії, які каса вже створила, — у справу; ще не створені — нагадати касі.
    await fresh.resolveNewCategories(shop.tenant_id, shop.started_by, options).catch(error => logger.warn({ code: (error as AppError)?.code }, '[category-sort] resolve failed'))
    let merged = false
    while (now() < deadline - 25_000) {
      const budget = new AiExecutionBudget(Math.max(5_000, deadline - now()))
      try {
        const page = await sortPage(shop.tenant_id, options, model, budget)
        placed += page.placed
        const cost = page.usage.reduce((sum, item) => sum + usageCostUsd(item), 0)
        if (page.usage.length) {
          const sum = (pick: (item: ClaudeUsage) => number) => page.usage.reduce((total, item) => total + pick(item), 0)
          await recordAiUsage(shop.tenant_id, shop.started_by, config.model, sum(item => item.promptTokens), sum(item => item.completionTokens), undefined, sum(item => item.costAdjustUsd ?? 0)).catch(() => undefined)
        }
        await pool.query('UPDATE supplier_category_sort SET cost_usd = cost_usd + $2, last_error = NULL, updated_at = now() WHERE tenant_id = $1', [shop.tenant_id, cost])
        // Сторінка без жодного нового питання й без товарів — усе розкладено; чекаємо нових надходжень.
        if (!page.offers && !merged) {
          // Усе розкладено по наявних категоріях. Якщо для частини видів потрібні нові — зводимо пропозиції й замовляємо касі.
          merged = true
          const made = await fresh.mergeNewCategories(shop.tenant_id, shop.started_by, options, model, budget)
          if (made) {
            await recordAiUsage(shop.tenant_id, shop.started_by, config.model, made.usage.promptTokens, made.usage.completionTokens, undefined, made.usage.costAdjustUsd ?? 0).catch(() => undefined)
            await pool.query('UPDATE supplier_category_sort SET cost_usd = cost_usd + $2, updated_at = now() WHERE tenant_id = $1', [shop.tenant_id, usageCostUsd(made.usage)])
            continue
          }
        }
        if (!page.offers || (!page.asked && page.offers < SORT_PAGE)) break
      } catch (error) {
        errors += 1
        logger.warn({ code: (error as AppError)?.code }, '[category-sort] page failed')
        await pool.query('UPDATE supplier_category_sort SET last_error = $2, updated_at = now() WHERE tenant_id = $1', [shop.tenant_id, error instanceof AppError ? error.message : 'Збій розкладки; повтор за хвилину.'])
        break
      } finally { budget.dispose() }
    }
  }
  return { shops: shops.length, placed, errors }
}
