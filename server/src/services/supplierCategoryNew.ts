import { pool } from '../db/pg.js'
import type { ClaudeUsage } from './aiClaude.js'
import type { AiExecutionBudget } from './aiExecutionBudget.js'
import { categoryKey, mergePrompt, NEW_CATEGORY_MAX_PER_RUN, NEW_CATEGORY_MIN_PRODUCTS, parseMergeReply, type CategoryOption } from './supplierCategoryKey.js'

/**
 * Нові категорії під товари постачальників (27.11.2026, слово власника: «якщо в нас такої категорії немає, то він її
 * створює»). Категорії — дані каси, тому сервер їх не вигадує в хмарі сам:
 *   1) пропозиції нових категорій від розкладки зводяться в мінімальний набір (схожі — в одну; підходить наявна — у неї;
 *      менше 15 товарів — категорію не створюємо, товари лишаються без категорії);
 *   2) касі ставиться команда «створити категорію» — каса створює її у своїй базі й сама передає в хмару;
 *   3) щойно категорія зʼявилась у хмарі — товари, що чекали, лягають у неї.
 * Головний ПК вимкнений — команда чекає до 7 днів, товари чекають разом із нею.
 */
type Model = { complete: (budget: AiExecutionBudget, input: { system: string; text: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }) => Promise<ClaudeUsage & { text: string; truncated: boolean }> }
const lower = (value: string) => value.trim().toLocaleLowerCase('uk-UA')
const lastName = (option: CategoryOption) => lower(option.path.split(' › ').at(-1)!)

async function queueCreate(tenantId: string, startedBy: string | null, name: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by)
     SELECT $1, gen_random_uuid(), 'category.create', jsonb_build_object('name', $2::text), $3
      WHERE NOT EXISTS (SELECT 1 FROM till_commands WHERE tenant_id = $1 AND command = 'category.create' AND payload->>'name' = $2
                           AND (status IN ('pending', 'claimed') OR created_at > now() - interval '30 minutes'))`, [tenantId, name, startedBy])
  return Boolean(rowCount)
}

/** Категорії, які каса вже створила й передала в хмару: правила отримують категорію, товари, що чекали, повертаються в чергу. */
export async function resolveNewCategories(tenantId: string, startedBy: string | null, options: readonly CategoryOption[]): Promise<{ resolved: number; queued: number }> {
  const waiting = (await pool.query('SELECT DISTINCT new_name FROM supplier_category_rules WHERE tenant_id = $1 AND new_final AND new_name IS NOT NULL AND category_id IS NULL', [tenantId])).rows as Array<{ new_name: string }>
  if (!waiting.length) return { resolved: 0, queued: 0 }
  const byName = new Map(options.map(option => [lastName(option), option.id]))
  let resolved = 0, queued = 0
  for (const { new_name: name } of waiting) {
    const id = byName.get(lower(name))
    if (id) {
      await pool.query('UPDATE supplier_category_rules SET category_id = $3, new_name = NULL, new_final = false WHERE tenant_id = $1 AND new_final AND new_name = $2', [tenantId, name, id])
      resolved += 1
    } else if (await queueCreate(tenantId, startedBy, name)) queued += 1
  }
  if (resolved) await pool.query("UPDATE supplier_offers SET category_source = NULL WHERE tenant_id = $1 AND category_source = 'ai_wait'", [tenantId])
  if (queued) await (await import('./tillWake.js')).wakeTill(tenantId).catch(() => undefined)
  return { resolved, queued }
}

/** Звести пропозиції нових категорій і замовити касі створення. Повертає null, якщо пропозицій немає. */
export async function mergeNewCategories(tenantId: string, startedBy: string | null, options: readonly CategoryOption[], model: Model, budget: AiExecutionBudget): Promise<{ created: string[]; usage: ClaudeUsage } | null> {
  const rules = (await pool.query('SELECT key, new_name FROM supplier_category_rules WHERE tenant_id = $1 AND new_name IS NOT NULL AND NOT new_final', [tenantId])).rows as Array<{ key: string; new_name: string }>
  if (!rules.length) return null
  const nameOfKey = new Map(rules.map(rule => [rule.key, rule.new_name]))
  // Скільки товарів чекає на кожну пропозицію (вид товару рахуємо так само, як при розкладці).
  const stats = new Map<string, { count: number; samples: string[] }>()
  const offers = (await pool.query("SELECT name, category_name FROM supplier_offers WHERE tenant_id = $1 AND category_source = 'ai_wait' LIMIT 200000", [tenantId])).rows as Array<{ name: string; category_name: string | null }>
  for (const offer of offers) {
    const key = categoryKey(offer), name = key ? nameOfKey.get(key) : undefined
    if (!name) continue
    const stat = stats.get(name) ?? { count: 0, samples: [] }
    stat.count += 1; if (stat.samples.length < 3) stat.samples.push(offer.name)
    stats.set(name, stat)
  }
  const proposals = [...new Set(rules.map(rule => rule.new_name))].sort((a, b) => (stats.get(b)?.count ?? 0) - (stats.get(a)?.count ?? 0)).slice(0, 400)
  const text = proposals.map((name, index) => `№${index + 1} | «${name}» | товарів: ${stats.get(name)?.count ?? 0} | приклади: ${(stats.get(name)?.samples ?? []).map(sample => sample.replace(/\s+/g, ' ').slice(0, 90)).join(' ;; ')}`).join('\n')
  const answer = await model.complete(budget, { system: mergePrompt(options), text, maxTokens: 8000, effort: 'medium' })
  const existingByName = new Map(options.map(option => [lastName(option), option.id]))
  const created: string[] = []
  for (const group of parseMergeReply(answer.text, proposals.length, options.length)) {
    const names = group.from.map(n => proposals[n - 1])
    const total = names.reduce((sum, name) => sum + (stats.get(name)?.count ?? 0), 0)
    const existing = group.existing > 0 ? options[group.existing - 1].id : existingByName.get(lower(group.name))
    if (existing) {
      await pool.query('UPDATE supplier_category_rules SET category_id = $3, new_name = NULL WHERE tenant_id = $1 AND NOT new_final AND new_name = ANY($2)', [tenantId, names, existing])
    } else if (total >= NEW_CATEGORY_MIN_PRODUCTS && created.length < NEW_CATEGORY_MAX_PER_RUN) {
      await pool.query('UPDATE supplier_category_rules SET new_name = $3, new_final = true WHERE tenant_id = $1 AND NOT new_final AND new_name = ANY($2)', [tenantId, names, group.name])
      await queueCreate(tenantId, startedBy, group.name)
      created.push(group.name)
    }
  }
  // Усе, що не потрапило в жодну групу або замале для окремої категорії, — «не певен»: товари лишаються без категорії.
  await pool.query('UPDATE supplier_category_rules SET new_name = NULL WHERE tenant_id = $1 AND NOT new_final AND new_name IS NOT NULL', [tenantId])
  await pool.query("UPDATE supplier_offers SET category_source = NULL WHERE tenant_id = $1 AND category_source = 'ai_wait'", [tenantId])
  if (created.length) await (await import('./tillWake.js')).wakeTill(tenantId).catch(() => undefined)
  return { created, usage: answer }
}

/** Для рядка стану: які нові категорії чекають касу і чи каса відмовила. */
export async function newCategoryStatus(tenantId: string): Promise<{ waiting_names: string[]; till_error: string | null }> {
  const names = (await pool.query('SELECT DISTINCT new_name FROM supplier_category_rules WHERE tenant_id = $1 AND new_final AND new_name IS NOT NULL AND category_id IS NULL ORDER BY 1 LIMIT 40', [tenantId])).rows.map((row: { new_name: string }) => row.new_name)
  if (!names.length) return { waiting_names: [], till_error: null }
  const failed = (await pool.query("SELECT error FROM till_commands WHERE tenant_id = $1 AND command = 'category.create' AND status = 'failed' AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 1", [tenantId])).rows[0]
  return { waiting_names: names, till_error: (failed?.error as string | undefined) ?? null }
}
