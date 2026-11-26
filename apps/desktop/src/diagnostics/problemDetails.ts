import { safeDiagnosticDetails } from './blackBoxData'
import { isStoredReceivingDetail, receivingProblemDetail } from './receivingReasons'

const explanations: Record<string, string> = {
  unknown: 'Технічна помилка; причину можна зіставити за відбитком',
  message: 'Повідомлення програми',
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
  'sync-invoice-products-missing': 'Сервер ще не має карток товарів цієї накладної; накладна піде після карток',
  'sync-sale-product-missing': 'Сервер ще не має картки товару з цього чека; чек піде після картки',
  'sync-not-confirmed': 'Сервер не підтвердив документ — чекає попередню операцію; повтор автоматичний',
  'sync-other-shop': 'Операція належить іншому магазину',
  'sync-signature-required': 'Сервер вимагає підписану копію — оновіть програму каси',
  'sync-reset-required': 'Локальна копія застаріла — потрібне повне оновлення з сервера',
}
/**
 * Відомі відповіді сервера на передачу (без назв, артикулів і цін) — замість «Технічна помилка [unknown]».
 * 19.11.2026: 143 записи журналу показували лише відбиток, і кожен збій доводилося розслідувати.
 */
const knownServerReplies: Array<[RegExp, string]> = [
  [/Спочатку передайте картки всіх товарів приходу/i, 'sync-invoice-products-missing'],
  [/Не передано картку товару цього чека/i, 'sync-sale-product-missing'],
  [/Сервер не підтвердив цей документ/i, 'sync-not-confirmed'],
  [/Операція належить іншому магазину/i, 'sync-other-shop'],
  [/MIRROR_SIGNATURE_REQUIRED|Основну локальну базу захищено/i, 'sync-signature-required'],
  [/SYNC_RESET_REQUIRED|іншому поколінню даних/i, 'sync-reset-required'],
]
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
  // Уже збережений запис із технічною формою помилки (26.11.2026) — лишаємо, якщо форма досі з дозволеного переліку.
  if (prior && prior[2] === 'unknown' && prior[1].startsWith(explanations.unknown + ': ') && technicalShape(prior[1].slice(explanations.unknown.length + 2)) === prior[1].slice(explanations.unknown.length + 2)) return text
  const storedReceiving = /^(.*) \[(receiving-[a-z-]+)(?::([a-z-]+))?\]\.(?: Відбиток: [a-f0-9]{20}\.)?$/.exec(text)
  if (storedReceiving && isStoredReceivingDetail(storedReceiving[1], storedReceiving[2])
    && (!storedReceiving[3] || Object.hasOwn(explanations, storedReceiving[3]))) return text
  const receiving = receivingProblemDetail(text)
  if (receiving && receiving.code.startsWith('receiving-step-')) {
    // Крок відомий, а сама помилка лишається відбитком: її текст може містити назви й артикули.
    const inner = safeDiagnosticDetails(text.replace(/^[\s\S]*RECEIVING_STEP:[a-z-]+:\s*/, ''))
    const innerCode = Object.hasOwn(explanations, String(inner.error_code)) ? String(inner.error_code) : 'unknown'
    return `${receiving.explanation}; ${explanations[innerCode]} [${receiving.code}:${innerCode}]. Відбиток: ${inner.fingerprint}.`
  }
  if (receiving) return `${receiving.explanation} [${receiving.code}].`
  const diagnostic = safeDiagnosticDetails(text)
  const known = knownServerReplies.find(([pattern]) => pattern.test(text))?.[1]
  if (known) return explanations[known] + ' [' + known + ']. Відбиток: ' + diagnostic.fingerprint + '.'
  const own = ownMessage(text)
  if (own && !diagnostic.error_code) return own + ' [message]. Відбиток: ' + diagnostic.fingerprint + '.'
  const candidate = text.includes('products_brand_id_fkey') ? 'foreign-brand-key' : String(diagnostic.error_code ?? 'unknown')
  const code = Object.hasOwn(explanations, candidate) ? candidate : 'unknown'
  const shape = code === 'unknown' ? technicalShape(text) : null
  return explanations[code] + (shape ? ': ' + shape : '') + ' [' + code + ']. Відбиток: ' + diagnostic.fingerprint + '.'
}

/**
 * 26.11.2026 (аудит): «Технічна помилка [unknown]» — 101 раз на сканері ревізії й 13 разів на її завершенні; причину
 * за самим відбитком уже не відновити. Форму помилки, у якій НЕМАЄ даних магазину, тепер видно в журналі:
 * обмеження бази (назви таблиці й колонки — це схема програми) і типові помилки коду (назва поля в коді).
 * Усе інше, як і раніше, лишається лише відбитком.
 */
export function technicalShape(text: string): string | null {
  const line = text.split('\n')[0].replace(/^(?:Error invoking remote method '[\w:.-]+': )?(?:\w*Error: )*/, '').trim()
  const constraint = /^(NOT NULL|UNIQUE|CHECK|FOREIGN KEY) constraint failed(?:: ([a-z_]+(?:\.[a-z_]+)?(?:, [a-z_]+\.[a-z_]+){0,5}))?$/.exec(line)
  if (constraint) return constraint[1] + ' constraint failed' + (constraint[2] ? ': ' + constraint[2] : '')
  const sqlite = /^(no such (?:table|column): [a-zA-Z_.]{1,60}|database is locked|database disk image is malformed|too many SQL variables|cannot (?:start|commit|rollback) (?:a )?transaction[a-z -]{0,60})$/.exec(line)
  if (sqlite) return sqlite[1]
  const code = /^(Cannot read properties of (?:undefined|null) \(reading '[A-Za-z_$][\w$]{0,40}'\)|[A-Za-z_$][\w$.]{0,60} is not (?:a function|iterable|defined)|Maximum call stack size exceeded|Unexpected end of JSON input|The database connection is not open)$/.exec(line)
  return code ? code[1] : null
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

/**
 * 20.11.2026: журнал показував «Технічна помилка [unknown]» навіть там, де програма сама пояснила
 * причину українською («Сесію ревізії вже завершено…»). Власне повідомлення програми показуємо,
 * але без того, що в лапках (назви товарів, імена) і без довгих чисел (телефони, коди).
 */
export function ownMessage(text: string): string | null {
  const line = text.split('\n')[0].trim()
  if (!/^[А-ЯІЇЄҐ]/u.test(line) || line.length > 240 || /@|\bat\s|https?:/i.test(line)) return null
  return line.replace(/«[^»]*»/gu, '«…»').replace(/"[^"]*"/g, '"…"').replace(/\d{6,}/g, '…')
}
