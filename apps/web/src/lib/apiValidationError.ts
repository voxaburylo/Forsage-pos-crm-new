/** Describe known field failures without displaying submitted values or arbitrary server details. */
export function apiValidationError(path: string, message: string, code: unknown, details: unknown): string {
  if (code !== 'VALIDATION_ERROR' || !['/api/v1/ai/chat', '/api/v1/ai/supply-invoice-photo'].includes(path)) return message
  const fields = details && typeof details === 'object' && 'fieldErrors' in details ? details.fieldErrors : null
  if (!fields || typeof fields !== 'object') return message
  const names = Object.keys(fields).filter(key => Array.isArray((fields as Record<string, unknown>)[key]) && ((fields as Record<string, unknown[]>)[key]).length)
  if (names.includes('history')) return 'Історія ШІ-діалогу перевищує дозволений обсяг або має неправильний формат. Оновіть програму або почніть новий діалог.'
  if (names.includes('images')) return 'Фото не пройшло перевірку. Додайте від 1 до 4 фото у форматі JPG, PNG або WebP.'
  if (names.includes('message')) return 'Повідомлення для ШІ не пройшло перевірку: потрібен текст до 20 000 символів. Скоротіть коментар до фото.'
  if (names.includes('file_text')) return 'Текст таблиці перевищує дозволений обсяг. Розділіть файл на менші частини.'
  return message
}
