const IPC_PREFIX = /^Error invoking remote method ['"][^'"]+['"]:\s*/i

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '')
}

const INTERNAL_CODE_MESSAGES: Record<string, string> = {
  LOCAL_DATABASE_NOT_READY: 'Локальна база ще запускається. Зачекайте кілька секунд і повторіть.',
  LOCAL_DATA_ROOT_NOT_READY: 'Локальне сховище програми ще не готове. Перезапустіть програму.',
  LOCAL_CATALOG_NOT_READY: 'Локальний каталог товарів ще не готовий. Зачекайте кілька секунд і повторіть.',
  LOCAL_INVENTORY_NOT_READY: 'Локальна ревізія ще не готова. Зачекайте кілька секунд і повторіть.',
  LOCAL_ORDERS_NOT_READY: 'Локальні замовлення ще не готові. Зачекайте кілька секунд і повторіть.',
  LOCAL_POS_NOT_READY: 'Локальна каса ще не готова. Зачекайте кілька секунд і повторіть.',
  LOCAL_SUPPLY_NOT_READY: 'Локальні накладні ще не готові. Зачекайте кілька секунд і повторіть.',
  LOCAL_STAFF_NOT_READY: 'Локальні співробітники ще не готові. Зачекайте кілька секунд і повторіть.',
  LOCAL_WAREHOUSE_NOT_READY: 'Локальний склад ще не готовий. Зачекайте кілька секунд і повторіть.',
  LOCAL_SYNC_NOT_READY: 'Синхронізація ще не готова. Зачекайте кілька секунд і повторіть.',
  LOCAL_SUPPLIER_CATALOG_NOT_READY: 'Локальний прайс постачальника ще не готовий. Зачекайте кілька секунд і повторіть.',
  LOCAL_BOOTSTRAP_NOT_READY: 'Початкове завантаження локальної бази ще не завершене.',
  LOCAL_PULL_CURSOR_REQUIRED: 'Синхронізація отримала неповні дані. Оновіть програму та повторіть.',
  LOCAL_PRODUCT_UPSERT_FAILED: 'Не вдалося зберегти товар у локальній базі. Оновіть дані та повторіть.',
  LOCAL_PRODUCT_RESTORE_FAILED: 'Не вдалося відновити товар у локальній базі. Оновіть дані та повторіть.',
  LOCAL_NO_SHIFT: 'Касову зміну не відкрито.',
  LOCAL_OPEN_SHIFT_REQUIRED: 'Спочатку відкрийте касову зміну.',
  LOCAL_SALE_EMPTY: 'Чек порожній. Додайте товар.',
  LOCAL_SALE_PAYMENT_REQUIRED: 'Вкажіть спосіб оплати.',
  LOCAL_SALE_INVALID_QTY: 'Некоректна кількість товару.',
  LOCAL_PRODUCT_NOT_FOUND: 'Товар не знайдено в локальній базі. Оновіть дані або виберіть товар заново.',
  LOCAL_SALE_INVALID_PRICE: 'Некоректна ціна товару.',
  LOCAL_SALE_INVALID_AMOUNT: 'Некоректна сума оплати. Перевірте введені суми.',
  LOCAL_SALE_INVALID_DISCOUNT: 'Знижка має бути невід’ємною і не перевищувати вартість товарів.',
  LOCAL_SALE_INVALID_BONUS: 'Некоректна сума списання бонусів.',
  LOCAL_SALE_INVALID_PAYMENT_METHOD: 'Невідомий спосіб оплати. Виберіть його заново.',
  LOCAL_ASYNC_TRANSACTION_FORBIDDEN: 'Операцію зупинено до збереження через внутрішню помилку. Зверніться до адміністратора.',
  LOCAL_BACKUP_CORRUPT: 'Резервна копія пошкоджена. Робочу базу не замінено.',
  LOCAL_BACKUP_MISSING_TABLE: 'Резервна копія неповна: відсутні потрібні дані. Робочу базу не замінено.',
  LOCAL_BACKUP_BROKEN_REFERENCES: 'Резервна копія має порушені зв’язки між документами. Відновлення з неї заблоковано.',
  LOCAL_BACKUP_NOT_FORSAGE_DATABASE: 'Це не резервна копія бази Форсажу.',
  LOCAL_BACKUP_INVALID_SCHEMA: 'Не вдалося перевірити версію резервної копії.',
  LOCAL_BACKUP_SAME_FILE: 'Не можна записувати резервну копію поверх робочої бази.',
  LOCAL_BACKUP_TIMEOUT: 'Створення резервної копії не завершилося вчасно. Попередні копії збережено.',
  LOCAL_BACKUP_INCOMPLETE: 'Резервну копію не завершено. Попередні копії збережено.',
  LOCAL_SALE_PAYMENT_MISMATCH: 'Сума оплати не збігається з сумою чека.',
  LOCAL_PAYMENT_OPERATION_CONFLICT: 'Цей номер операції вже використано для іншого чека.',
  LOCAL_RETURN_OPERATION_CONFLICT: 'Цей номер операції вже використано для іншого повернення.',
  FISCAL_SERVICE_NOT_READY: 'Фіскальний сервіс ще не готовий. Перевірте налаштування ПРРО.',
  FISCAL_ENCRYPTION_UNAVAILABLE: 'Недоступне захищене сховище для ПРРО. Перезапустіть програму.',
  FISCAL_RRO_NOT_CONFIGURED: 'Не вказано фіскальний номер РРО в налаштуваннях ПРРО.',
  FISCAL_CALL_TIMEOUT: 'ПРРО не відповів вчасно. Перевірте Cashalot і повторіть.',
  FISCAL_CALL_FAILED: 'Помилка обміну з ПРРО. Перевірте Cashalot і повторіть.',
  FISCAL_OPERATION_REJECTED: 'ПРРО відхилив операцію. Перевірте повідомлення Cashalot.',
  FISCAL_CHECK_EMPTY: 'Фіскальний чек порожній.',
  FISCAL_OPERATION_ID_REQUIRED: 'Не вдалося створити номер фіскальної операції. Повторіть дію.',
  FISCAL_INTENT_NOT_READY: 'Фіскальна операція ще не готова. Перевірте результат у ПРРО.',
  FISCAL_INTENT_CONFLICT: 'Дані фіскальної операції не збігаються. Перевірте чек у ПРРО.',
  FISCAL_DLL_NOT_FOUND: 'DLL Cashalot не знайдено. Перевірте шлях у налаштуваннях ПРРО.',
  FISCAL_COM_REGISTER_FAILED: 'Не вдалося зареєструвати компонент Cashalot. Перевірте права адміністратора.',
  FISCAL_WORKER_EXITED: 'Служба Cashalot зупинилась. Перезапустіть програму та Cashalot.',
  PRINT_HTML_EMPTY: 'Немає документа для друку.',
  PRINT_DOCUMENT_LOAD_FAILED: 'Не вдалося підготувати макет друку. Завдання ще не надіслано принтеру.',
  PRINT_RUNTIME_FILES_MISSING: 'Відсутні службові файли програми для друку. Збережіть роботу, повністю закрийте «Форсаж» і відкрийте знову. Завдання ще не надіслано принтеру.',
  PRINT_SESSION_REQUIRED: 'Не вдалося відкрити ізольоване вікно друку. Перезапустіть програму.',
  PRINT_TIMEOUT: 'Принтер не відповів вчасно.',
  PRINT_FAILED: 'Не вдалося надрукувати документ.',
  MIRROR_IDENTITY_UNAVAILABLE: 'Не вдалося відкрити захищений ключ серверної копії. Локальні дані збережено; зверніться до адміністратора для відновлення ключа.',
  PRINT_GUARD_UNAVAILABLE: 'Не вдалося перевірити чергу принтера. Автоматичний повтор друку не виконувався.',
  PRINT_GUARD_TIMEOUT: 'Принтер не відповів на перевірку вчасно. Перевірте чергу й фактичний друк перед повтором.',
  PRINT_QUEUE_STUCK: 'У черзі принтера зависло попереднє завдання. Очистіть чергу друку.',
  PRINT_PRINTER_NOT_READY: 'Принтер не готовий. Перевірте живлення, кабель і папір.',
  PRINT_NOT_CONFIRMED: 'Принтер не підтвердив друк. Перевірте чергу друку.',
  TSPL_PRINTER_NOT_SET: 'Принтер етикеток не вибрано.',
  TSPL_NO_LABELS: 'Немає етикеток для друку.',
  TSPL_QUEUE_STUCK: 'У черзі принтера етикеток зависло попереднє завдання. Очистіть чергу друку.',
  TSPL_PRINTER_NOT_READY: 'Принтер етикеток не готовий. Перевірте живлення, USB, стрічку й кришку.',
  TSPL_PRINT_NOT_CONFIRMED: 'Принтер етикеток не підтвердив друк. Перевірте чергу друку.',
  TSPL_CAPTURE_SIZE: 'Не вдалося підготувати етикетку потрібного розміру для друку.',
  TSPL_BARCODE_TOO_NARROW: 'Штрих-код занадто вузький для надійного друку. Збільште його ширину в дизайнері етикетки.',
  TSPL_BARCODE_PATTERN_INVALID: 'Не вдалося підготувати штрих-код. Збережіть його налаштування в дизайнері ще раз.',
  TSPL_BARCODE_IMAGE_NOT_FOUND: 'Не вдалося знайти штрих-код у макеті етикетки. Збережіть дизайн і повторіть друк.',
  TSPL_BARCODE_CANVAS_UNAVAILABLE: 'Не вдалося підготувати чіткий штрих-код для друку. Перезапустіть програму та повторіть.',
  RAW_PRINT_TIMEOUT: 'Принтер етикеток не відповів вчасно.',
  RAW_PRINT_EMPTY: 'Немає даних для друку етикетки.',
  RAW_PRINT_OPEN_FAILED: 'Не вдалося відкрити вибраний принтер етикеток.',
  RAW_PRINT_STARTDOC_FAILED: 'Не вдалося почати друк етикетки.',
  RAW_PRINT_WRITE_FAILED: 'Принтер прийняв етикетку не повністю.',
  RAW_PRINT_INCOMPLETE: 'Принтер прийняв етикетку не повністю.',
}

function localizeInternalCode(message: string): string | null {
  const pipeIndex = message.indexOf('|')
  const rawCode = (pipeIndex >= 0 ? message.slice(0, pipeIndex) : message).trim()
  const detail = pipeIndex >= 0 ? message.slice(pipeIndex + 1).trim() : ''
  const code = rawCode.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0]
  if (!code) return null

  const mapped = INTERNAL_CODE_MESSAGES[code]
  if (detail && (mapped || /^[A-Z0-9_]+$/.test(rawCode))) return detail
  return mapped ?? null
}

export function localizeDesktopIpcError(error: unknown): Error {
  let message = rawMessage(error).trim()

  // This marker is part of the fiscal recovery protocol. Keep it byte-for-byte
  // from the marker onwards so the renderer can offer the recovery flow.
  const fiscalMarker = message.indexOf('FISCAL_INTENT_UNKNOWN|')
  if (fiscalMarker >= 0) return new Error(message.slice(fiscalMarker))

  const pendingReturnMarker = 'FISCAL_RETURN_PENDING|'
  const pendingReturnAt = message.indexOf(pendingReturnMarker)
  if (pendingReturnAt >= 0) {
    const visibleMessage = message.slice(pendingReturnAt + pendingReturnMarker.length).trim()
    return new Error(visibleMessage || 'Є незавершене фіскальне повернення')
  }

  message = message.replace(IPC_PREFIX, '').replace(/^Error:\s*/i, '').trim()
  if (/PRINT_SUBMISSION_STARTED|PRINT_OUTCOME_UNKNOWN|print-outcome-unknown|PRINT_NOT_CONFIRMED|TSPL_TOTAL_TIMEOUT|RAW_PRINT_TIMEOUT|TSPL_PRINT_ABORTED/.test(message)) {
    return new Error('Не вдалося підтвердити результат друку. Документ міг бути надрукований частково або повністю. Перевірте папір і чергу перед повтором.')
  }
  if (message.includes('PRINT_REPEAT_CANCELLED')) return new Error('Друк скасовано. Перевірте попереднє завдання у черзі принтера.')
  const lower = message.toLowerCase()

  if (lower.includes('foreign key constraint failed')) {
    return new Error('Не вдалося зберегти зміни: пов’язаний запис не знайдено. Оновіть дані та повторіть.')
  }
  if (lower.includes('unique constraint failed') || lower.includes('constraint unique')) {
    return new Error('Такий запис уже існує. Перевірте введені дані.')
  }
  if (
    lower.includes('sqlite_busy') ||
    lower.includes('database is locked') ||
    lower.includes('database table is locked')
  ) {
    return new Error('Локальна база зараз зайнята іншою операцією. Зачекайте кілька секунд і повторіть.')
  }

  const internalCodeMessage = localizeInternalCode(message)
  if (internalCodeMessage) return new Error(internalCodeMessage)

  return new Error(message || 'Не вдалося виконати локальну операцію')
}
