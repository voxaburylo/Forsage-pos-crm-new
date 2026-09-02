import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProblem, type LocalProblemInput, type LocalProblemSummary } from '../db/localTypes'

/**
 * Скільки вирішених записів тримаємо. Журнал має пережити місяці роботи каси,
 * не перетворившись на другу базу: відкриті проблеми не чіпаємо ніколи,
 * прибираємо тільки найстаріші вирішені.
 */
const RESOLVED_HISTORY_LIMIT = 500

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Технічний текст помилки може містити цілий payload операції. У журналі він
 * потрібен для розуміння причини, але не в повному обсязі.
 */
function trimDetail(value: string | null | undefined): string | null {
  if (!value) return null
  const clean = String(value).trim()
  if (!clean) return null
  return clean.length > 2000 ? `${clean.slice(0, 2000)}…` : clean
}

type ProblemRow = {
  id: string
  source: string
  code: string
  severity: string
  title: string
  detail: string | null
  entity_type: string | null
  entity_id: string | null
  context_json: string | null
  occurrences: number
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
}

function toProblem(row: ProblemRow): LocalProblem {
  let context: Record<string, unknown> | null = null
  if (row.context_json) {
    try {
      const parsed = JSON.parse(row.context_json)
      context = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      context = null
    }
  }
  return {
    id: row.id,
    source: row.source as LocalProblem['source'],
    code: row.code,
    severity: row.severity === 'warning' ? 'warning' : 'error',
    title: row.title,
    detail: row.detail,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    context,
    occurrences: row.occurrences,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    resolved_at: row.resolved_at,
  }
}

/**
 * Журнал проблем каси. Пише сюди все, що зламалось під час роботи: відхилені
 * сервером операції, збої друку, ПРРО, відновлення бази. Один рядок — одна
 * проблема; повтори збільшують лічильник, щоб список лишався читабельним.
 */
export class LocalProblemRepository {
  constructor(private readonly db: LocalDatabase) {}

  record(input: LocalProblemInput): void {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const detail = trimDetail(input.detail)
    const contextJson = input.context ? JSON.stringify(input.context) : null
    const severity = input.severity === 'warning' ? 'warning' : 'error'

    // Журнал не має права зламати операцію, під час якої його викликали:
    // збій запису проблеми не повинен скасувати продаж чи синхронізацію.
    try {
      this.db.transaction(() => {
        const existing = this.db.prepare(`
          SELECT id FROM problem_log
          WHERE tenant_id = ? AND source = ? AND code = ?
            AND COALESCE(entity_type, '') = COALESCE(?, '')
            AND COALESCE(entity_id, '') = COALESCE(?, '')
            AND resolved_at IS NULL
          LIMIT 1
        `).get(tenantId, input.source, input.code, input.entity_type ?? null, input.entity_id ?? null) as { id: string } | undefined

        if (existing) {
          this.db.prepare(`
            UPDATE problem_log
            SET occurrences = occurrences + 1,
                last_seen_at = ?,
                severity = ?,
                title = ?,
                detail = COALESCE(?, detail),
                context_json = COALESCE(?, context_json)
            WHERE id = ?
          `).run(timestamp, severity, input.title, detail, contextJson, existing.id)
          return
        }

        this.db.prepare(`
          INSERT INTO problem_log (
            id, tenant_id, source, code, severity, title, detail,
            entity_type, entity_id, context_json,
            occurrences, first_seen_at, last_seen_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
        `).run(
          randomUUID(), tenantId, input.source, input.code, severity, input.title, detail,
          input.entity_type ?? null, input.entity_id ?? null, contextJson,
          timestamp, timestamp,
        )
        this.pruneResolved(tenantId)
      })
    } catch {
      // Свідомо мовчимо: журнал — допоміжний, а не критичний шлях.
    }
  }

  list(options: { tenantId?: string; includeResolved?: boolean; limit?: number } = {}): LocalProblem[] {
    const tenantId = options.tenantId ?? DEFAULT_TENANT_ID
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
    const scope = options.includeResolved ? '' : 'AND resolved_at IS NULL'
    const rows = this.db.prepare(`
      SELECT id, source, code, severity, title, detail, entity_type, entity_id,
             context_json, occurrences, first_seen_at, last_seen_at, resolved_at
      FROM problem_log
      WHERE tenant_id = ? ${scope}
      ORDER BY resolved_at IS NOT NULL, last_seen_at DESC
      LIMIT ?
    `).all(tenantId, limit) as unknown as ProblemRow[]
    return rows.map(toProblem)
  }

  summary(tenantId = DEFAULT_TENANT_ID): LocalProblemSummary {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN resolved_at IS NULL AND severity = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN resolved_at IS NULL AND severity = 'warning' THEN 1 ELSE 0 END) AS warnings,
        MAX(CASE WHEN resolved_at IS NULL THEN last_seen_at END) AS last_seen_at
      FROM problem_log
      WHERE tenant_id = ?
    `).get(tenantId) as { errors: number | null; warnings: number | null; last_seen_at: string | null } | undefined
    return {
      errors: Number(row?.errors ?? 0),
      warnings: Number(row?.warnings ?? 0),
      last_seen_at: row?.last_seen_at ?? null,
    }
  }

  resolve(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    this.db.prepare(`
      UPDATE problem_log SET resolved_at = ?
      WHERE id = ? AND tenant_id = ? AND resolved_at IS NULL
    `).run(nowIso(), id, tenantId)
    return { ok: true }
  }

  resolveAll(tenantId = DEFAULT_TENANT_ID): { resolved: number } {
    const open = this.db.prepare(`
      SELECT COUNT(*) AS total FROM problem_log WHERE tenant_id = ? AND resolved_at IS NULL
    `).get(tenantId) as { total: number } | undefined
    this.db.prepare(`
      UPDATE problem_log SET resolved_at = ? WHERE tenant_id = ? AND resolved_at IS NULL
    `).run(nowIso(), tenantId)
    return { resolved: Number(open?.total ?? 0) }
  }

  /**
   * Текст для передачі розробнику: усе, що потрібно для розбору, без потреби
   * лізти в базу через провідник.
   */
  exportText(tenantId = DEFAULT_TENANT_ID): string {
    const problems = this.list({ tenantId, includeResolved: true, limit: 1000 })
    if (problems.length === 0) return 'Журнал проблем порожній.'
    const lines = [`Журнал проблем Форсажу — ${new Date().toLocaleString('uk-UA')}`, '']
    for (const problem of problems) {
      lines.push(`[${problem.resolved_at ? 'вирішено' : problem.severity === 'warning' ? 'увага' : 'помилка'}] ${problem.title}`)
      lines.push(`  джерело: ${problem.source} · код: ${problem.code} · повторів: ${problem.occurrences}`)
      lines.push(`  вперше: ${problem.first_seen_at} · востаннє: ${problem.last_seen_at}`)
      if (problem.entity_type) lines.push(`  об'єкт: ${problem.entity_type} ${problem.entity_id ?? ''}`.trimEnd())
      if (problem.detail) lines.push(`  деталі: ${problem.detail}`)
      lines.push('')
    }
    return lines.join('\n')
  }

  private pruneResolved(tenantId: string): void {
    this.db.prepare(`
      DELETE FROM problem_log
      WHERE tenant_id = ?
        AND resolved_at IS NOT NULL
        AND id NOT IN (
          SELECT id FROM problem_log
          WHERE tenant_id = ? AND resolved_at IS NOT NULL
          ORDER BY resolved_at DESC
          LIMIT ?
        )
    `).run(tenantId, tenantId, RESOLVED_HISTORY_LIMIT)
  }
}
