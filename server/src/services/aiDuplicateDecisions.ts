import { z } from 'zod'
import { logger } from '../lib/logger.js'

/**
 * 26.11.2026, слово власника: «пошук дублів знаходить повторно дублі, які ми вже виправили». Обʼєднані картки пошук не
 * бачить; повторювались пари, про які власник вирішив «це не дублі» (відхилив пропозицію або не відмітив сумнівну
 * пару при підтвердженні). Тут ці рішення зберігаються (таблиця ai_duplicate_decisions) і відсіюються з пошуку.
 * Таблиці ще немає (міграцію не застосовано) — пошук працює як раніше, а зберегти рішення не вдається з поясненням.
 */
export const duplicateDecisionsSchema = z.object({
  pairs: z.array(z.object({ a: z.string().uuid(), b: z.string().uuid() }).refine(pair => pair.a !== pair.b)).min(1).max(500),
})

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export async function saveDistinctPairs(tenantId: string, userId: string, pairs: Array<{ a: string; b: string }>): Promise<number> {
  const unique = [...new Map(pairs.map(pair => [pairKey(pair.a, pair.b), pair.a < pair.b ? pair : { a: pair.b, b: pair.a }])).values()]
  const { pool } = await import('../db/pg.js') // лінивий імпорт: модуль читають і тести без бази
  const { rowCount } = await pool.query(
    `INSERT INTO ai_duplicate_decisions (tenant_id, product_a, product_b, decided_by)
     SELECT $1, x.a, x.b, $2 FROM unnest($3::uuid[], $4::uuid[]) AS x(a, b)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, unique.map(pair => pair.a), unique.map(pair => pair.b)])
  return rowCount ?? 0
}

/** Пари «не дублі» цього магазину; таблиці немає чи помилка — порожньо (пошук як раніше). */
export async function readDistinctPairs(tenantId: string): Promise<Set<string>> {
  try {
    const { pool } = await import('../db/pg.js')
    const { rows } = await pool.query('SELECT product_a::text AS a, product_b::text AS b FROM ai_duplicate_decisions WHERE tenant_id = $1', [tenantId])
    return new Set(rows.map((row: { a: string; b: string }) => pairKey(row.a, row.b)))
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, 'ai duplicate decisions unavailable')
    return new Set()
  }
}

/**
 * Прибрати з групи «не дублі»: група лишається, лише якщо в ній є хоч одна пара, про яку власник ще не вирішив; з групи
 * відкидаються картки, які з усіма іншими позначені «не дубль».
 */
export function withoutDistinct<T extends { id: unknown }>(group: readonly T[], distinct: ReadonlySet<string>): T[] {
  const id = (row: T) => String(row.id)
  const open = (a: T, b: T) => !distinct.has(pairKey(id(a), id(b)))
  const kept = group.filter(row => group.some(other => other !== row && open(row, other)))
  return kept.length >= 2 ? kept : []
}
