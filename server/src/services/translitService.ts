/**
 * Сервіс транслітерації для пошуку товарів.
 * Конвертує латинські літери в кирилицю.
 */

// Пріоритет — українська транслітерація, з підтримкою російських варіантів
const TRANSLIT_MAP: Record<string, string> = {
  // Голосні (український стандарт: i→і, y→и)
  'a': 'а', 'e': 'е', 'o': 'о', 'u': 'у', 'i': 'і', 'y': 'и',
  // Приголосні
  'b': 'б', 'v': 'в', 'g': 'г', 'd': 'д', 'zh': 'ж', 'z': 'з',
  'k': 'к', 'l': 'л', 'm': 'м', 'n': 'н', 'p': 'п', 'r': 'р',
  's': 'с', 't': 'т', 'f': 'ф', 'h': 'х', 'c': 'ц', 'ch': 'ч',
  'sh': 'ш', 'shch': 'щ', 'yu': 'ю', 'ya': 'я', 'ye': 'є',
  // Специфічні українські
  'yi': 'ї', 'yii': 'ї',
  // Додаткові
  'w': 'в', 'x': 'кс', 'q': 'к',
  // "М'які" варіанти
  'ia': 'я', 'ie': 'є', 'io': 'ьо', 'iu': 'ю',
}

// Сортуємо ключі по довжині (спочатку довші комбінації)
const TRANSLIT_KEYS = Object.keys(TRANSLIT_MAP).sort((a, b) => b.length - a.length)

/**
 * Конвертує латинський рядок в кирилицю.
 * Якщо рядок містить кирилицю — повертає без змін.
 */
export function transliterateToCyrillic(text: string): string {
  if (/[а-яА-ЯїЇєЄіІґҐ]/.test(text)) {
    return text
  }

  let result = text.toLowerCase()
  for (const key of TRANSLIT_KEYS) {
    const regex = new RegExp(key, 'g')
    result = result.replace(regex, TRANSLIT_MAP[key])
  }
  return result
}

/**
 * Перевіряє чи рядок містить латиницю (без кирилиці).
 */
export function isLatinText(text: string): boolean {
  return /[a-zA-Z]/.test(text) && !/[а-яА-ЯїЇєЄіІґҐ]/.test(text)
}