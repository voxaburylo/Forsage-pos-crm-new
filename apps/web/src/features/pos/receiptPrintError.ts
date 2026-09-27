/** Людське пояснення для кодів охорони черги друку (див. spoolerGuard). */
export function receiptPrintErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  if (raw.includes('PRINT_REPEAT_CANCELLED')) return 'Повтор скасовано. Перевірте попередній чек у черзі принтера.'
  if (raw.includes('PRINT_SUBMISSION_STARTED')) return 'Чек міг бути надрукований. Windows не підтвердила результат — перевірте папір і чергу перед повтором.'
  if (raw.includes('PRINT_DOCUMENT_LOAD_FAILED') || (/ERR_(FAILED|INVALID_URL|ABORTED)/.test(raw) && raw.includes('data:text/html'))) {
    return 'Не вдалося завантажити макет чека. Завдання ще не надіслано на принтер.'
  }
  if (raw.includes('PRINT_QUEUE_STUCK')) {
    return 'У черзі чекового принтера залипло старе завдання, і Windows не дає його прибрати. '
      + 'Перезапустіть службу «Диспетчер друку» (Спулер) або комп’ютер.'
  }
  if (raw.includes('PRINT_PRINTER_NOT_READY')) {
    return 'Чековий принтер не готовий: перевірте живлення, USB-кабель і наявність паперу. Чек НЕ надруковано.'
  }
  if (raw.includes('PRINT_RECEIPT_PRINTER_NOT_SET') || raw.includes('PRINT_RECEIPT_PRINTER_MISMATCH')) {
    return 'Чековий принтер POS-58 не знайдено. Чек не буде перенаправлено на принтер етикеток POS-80.'
  }
  if (raw.includes('PRINT_OUTCOME_UNKNOWN') || raw.includes('PRINT_NOT_CONFIRMED')) {
    return 'Windows не підтвердила результат друку. Не запускайте чек повторно автоматично: перевірте принтер і чергу друку.'
  }
  if (/PRINT_RECEIPT_(INVALID_RESOLUTION|INVALID_PAPER|PROFILE_FAILED|SETTINGS_CHANGED)/.test(raw)) {
    return 'Не вдалося визначити точні налаштування POS-58. Перевірте папір і роздільність у властивостях принтера; чек не надсилався повторно.'
  }
  if (/PRINT_RECEIPT_(SIZE_INVALID|CAPTURE_SCALE)/.test(raw)) {
    return 'Не вдалося підготувати чек у точному розмірі. Друк зупинено, щоб не надрукувати обрізаний або зменшений чек.'
  }
  if (raw.includes('PRINT_RENDER_TIMEOUT') || raw.includes('PRINT_RESOURCES_TIMEOUT')) {
    return 'Чек не вдалося підготувати до друку вчасно. Повторний прихований друк не запускався.'
  }
  const localized = raw.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/i, '').trim().split(/\r?\n/)[0]
  if (/^(У черзі принтера|Принтер |Не вдалося |Чек |Немає документа|Чековий принтер|Друк скасовано)/.test(localized)) return localized
  return ''
}
