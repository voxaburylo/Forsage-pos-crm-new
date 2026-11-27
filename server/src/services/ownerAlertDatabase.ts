import { DB_STUCK_QUERIES, type DbLoad } from './dbLoad.js'

/**
 * Тривога власнику «хмарна база гальмує» (27.11.2026). Уночі база вичерпала запас дискових операцій, і шість годин про це
 * ніхто не знав — першим написав сайт, який не міг забрати каталог. Сервер і так щоп'ять хвилин збирає факти для тривог:
 * тепер він ще й міряє, як швидко база відповіла.
 * Поріг для тривоги вищий, ніж для паузи фонової роботи (400 мс): коротке «зайнято» — буденність, а це — справжня біда.
 * Раз на три години, поки триває. Якщо база не відповідає зовсім, сервер не зможе надіслати й цю тривогу (чат власника й
 * журнал тривог лежать у тій самій базі) — тому вона ловить саме початок: коли база вже повільна, але ще жива.
 */
export const DB_ALERT_PROBE_MS = 1500
export const DB_ALERT_EVERY_HOURS = 3

export function databaseSlowAlert(load: DbLoad | null | undefined, today: string, hour: number): { key: string; text: string } | null {
  if (!load) return null
  const slow = load.probe_ms > DB_ALERT_PROBE_MS, stuck = load.stuck >= DB_STUCK_QUERIES
  if (!slow && !stuck) return null
  const seconds = (load.probe_ms / 1000).toFixed(1).replace('.', ',')
  return {
    key: `db_slow:${today}:${Math.floor(hour / DB_ALERT_EVERY_HOURS)}`,
    text: `🐢 Хмарна база гальмує: на просте питання відповідала ${seconds} с${load.stuck ? `, зависло запитів: ${load.stuck}` : ''}.`
      + '\nВеб, застосунок на телефоні й сайт можуть працювати повільно. Каса на головному ПК працює як завжди.'
      + '\nФонова робота (прайси постачальників, розкладка по категоріях, тексти для сайту) поставлена на паузу сама.'
      + '\nЯкщо за годину не минеться — відкрийте Supabase → «Программа магазин» → Observability → Database: чи не вичерпано Disk IO Budget.',
  }
}
