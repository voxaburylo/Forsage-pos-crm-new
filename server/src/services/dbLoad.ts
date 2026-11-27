import { pool } from '../db/pg.js'

/**
 * Чи база зараз перевантажена (27.11.2026). Уночі фонові задачі — розкладка товарів постачальників по категоріях, тексти для
 * сайту, прайси — вичерпали запас дискових операцій бази: оновлення одного рядка тривало 25–100 с, сайт не міг забрати
 * каталог, веб і застосунок не працювали, а фонові задачі далі стукали щохвилини й не давали базі оговтатись.
 * Тепер важка фонова робота спершу питає базу: відповідь повільна або в ній уже висять довгі запити — цей раз пропускаємо.
 * Продажі, замовлення й усе, що робить людина, цієї перевірки не проходять — вони важливіші за фон.
 */
export const DB_SLOW_PROBE_MS = 400
export const DB_STUCK_QUERIES = 3
export const DB_STUCK_SECONDS = 5

export function isDbBusy(probeMs: number, stuckQueries: number): boolean {
  return probeMs > DB_SLOW_PROBE_MS || stuckQueries >= DB_STUCK_QUERIES
}

export async function dbBusy(now: () => number = Date.now): Promise<boolean> {
  const started = now()
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS stuck FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid() AND now() - query_start > make_interval(secs => $1)`, [DB_STUCK_SECONDS])
    return isDbBusy(now() - started, Number(rows[0]?.stuck) || 0)
  } catch {
    // Не змогли навіть спитати — базі точно не до фонової роботи.
    return true
  }
}
