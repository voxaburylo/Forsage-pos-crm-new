/**
 * 21.11.2026 (план: «чистий журнал проблем»). Записи на кшталт «Команда каси «desktop:pos:checkout»
 * завершилась помилкою» показуємо людською мовою, а записи, які не повторювались понад 14 днів,
 * за замовчуванням ховаємо (вони лишаються в журналі, кнопка «Показати старі»).
 */
const CHANNEL_NAMES: Array<[RegExp, string]> = [
  [/^desktop:pos:checkout$/, 'Продаж на касі'],
  [/^desktop:pos:(open|close)-shift$/, 'Відкриття/закриття зміни'],
  [/^desktop:print:labels-tspl$/, 'Друк етикеток'],
  [/^desktop:print:/, 'Друк'],
  [/^desktop:inventory:scan$/, 'Сканування в ревізії'],
  [/^desktop:inventory:/, 'Ревізія'],
  [/^desktop:supply:commit-receiving$/, 'Проведення накладної'],
  [/^desktop:supply:/, 'Накладні'],
  [/^desktop:sync:/, 'Обмін із сервером'],
  [/^desktop:auth:/, 'Вхід у програму'],
  [/^desktop:backup:/, 'Резервна копія'],
  [/^desktop:catalog:/, 'Товари'],
  [/^desktop:orders:/, 'Замовлення'],
]

export const STALE_PROBLEM_DAYS = 14

export function problemTitle(title: string): string {
  const match = /^Команда каси «([^»]+)» завершилась помилкою$/.exec(title.trim())
  if (!match) return title
  const name = CHANNEL_NAMES.find(([pattern]) => pattern.test(match[1]))?.[1]
  return name ? `${name}: помилка` : title
}

export function problemDetail(detail: string | null | undefined): string | null {
  if (!detail) return null
  const fingerprint = /Відбиток: ([0-9a-f]+)/.exec(detail)?.[1]
  if (/^Технічна помилка/.test(detail.trim())) {
    return 'Причина не розпізнана. Якщо повторюється — повідомте розробнику' + (fingerprint ? ` (код ${fingerprint.slice(0, 8)}).` : '.')
  }
  return detail.replace(/\s*\[[a-z-]+\]\.?/g, '.').replace(/\s*Відбиток: [0-9a-f]+\.?/, '').replace(/\.\.+/g, '.').trim()
}

export function isStaleProblem(lastSeenAt: string, now = Date.now()): boolean {
  const time = Date.parse(lastSeenAt)
  return Number.isFinite(time) && now - time > STALE_PROBLEM_DAYS * 24 * 60 * 60 * 1000
}
