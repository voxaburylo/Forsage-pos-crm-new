import { safeDiagnosticDetails } from './blackBoxData'

const explanations: Record<string, string> = {
  unknown: 'Технічна помилка; причину можна зіставити за відбитком',
  'foreign-brand-key': 'Відсутній зв’язок із брендом товару (products_brand_id_fkey)',
  'foreign-key': 'Не знайдено пов’язаний запис',
  'unique-constraint': 'Запис з таким ідентифікатором уже існує',
  'database-busy': 'База даних зайнята іншою операцією',
  'database-corrupt': 'Виявлено пошкодження бази; потрібна перевірка відновлення',
  'disk-full': 'Не вистачає місця на диску',
  'file-permission': 'Немає доступу до потрібного файла',
  timeout: 'Операція не завершилася у відведений час',
  'insufficient-stock': 'Недостатньо залишку для цієї операції',
  'stale-customer-card': 'Картку клієнта вже змінено; відкрийте її заново',
  'printer-not-ready': 'Принтер не готовий до друку',
  'print-document-load-failed': 'Не вдалося завантажити макет друку',
  'print-runtime-files-missing': 'Бракує файлів компонента друку',
  'print-render-timeout': 'Підготовка макета друку не завершилася вчасно',
  'print-queue-stuck': 'Черга принтера не відповідає',
  'print-outcome-unknown': 'Результат друку не підтверджено; перевірте паперовий чек перед повтором',
  'print-timeout': 'Друк не завершився вчасно; перевірте принтер перед повтором',
  'print-driver-error': 'Драйвер принтера повернув помилку',
}
const fixedDetails: Record<string, string> = {
  'salary.legacy_commission_review': 'Повернення клієнту проведено. Зарплату автоматично не змінено: для старого чека немає однозначного розрахунку або вже потрібна ручна перевірка. Звірте початкове нарахування та попередні корекції; закриття цього повідомлення саме по собі зарплату не змінює.',
  'sync.inventory_copy_restored': 'Раніше документ було пропущено. Копія очікує сервера; локальні залишки не змінено.',
  'sync.inventory_copy_needs_review': 'Не вдалося однозначно звірити пропущений документ із завершеною локальною ревізією. Дані не змінено; автоматичне повторне проведення заборонено.',
  'sync.inventory_copy_queued': 'Сервер відхиляв застарілу копію. Документ і актуальний залишок поставлено в чергу окремо. Локальні дані не змінено.',
}

/** Both new records and legacy exports are safe; historical rows are not rewritten. */
export function safeProblemDetail(value: unknown, problemCode: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (Object.hasOwn(fixedDetails, problemCode)) return fixedDetails[problemCode]
  const text = value.slice(0, 8192)
  const prior = /^(.*) \[([a-z-]+)\]\. Відбиток: ([a-f0-9]{20})\.$/.exec(text)
  if (prior && prior[1] === explanations[prior[2]]) return text
  const diagnostic = safeDiagnosticDetails(text)
  const candidate = text.includes('products_brand_id_fkey') ? 'foreign-brand-key' : String(diagnostic.error_code ?? 'unknown')
  const code = Object.hasOwn(explanations, candidate) ? candidate : 'unknown'
  return explanations[code] + ' [' + code + ']. Відбиток: ' + diagnostic.fingerprint + '.'
}

export function safeProblemContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const diagnostic = safeDiagnosticDetails(value)
  const data: Record<string, unknown> = {}
  // Context is auxiliary: do not retain free-form strings from old SDK payloads.
  for (const key of ['sequence', 'attempt', 'attempts', 'duration_ms', 'exitCode', 'schemaVersion']) {
    if (diagnostic[key] !== undefined) data[key] = diagnostic[key]
  }
  const error = diagnostic.error
  if (error && typeof error === 'object') {
    const safe: Record<string, unknown> = {}
    for (const key of ['fingerprint', 'error_code', 'error_type']) {
      const item = (error as Record<string, unknown>)[key]
      if (typeof item === 'string') safe[key] = item
    }
    if (Object.keys(safe).length) data.error = safe
  }
  return Object.keys(data).length ? data : null
}
