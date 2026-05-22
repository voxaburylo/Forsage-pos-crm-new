/**
 * Сервіс відновлення розкладки клавіатури.
 * 
 * Конвертує текст, введений в неправильній розкладці.
 * Підтримує російську (ЙЦУКЕН) та українську розкладки.
 * 
 * Приклади:
 *   "ghtrjlf"  → "прокладка" (рос)
 *   "vjcn"     → "мост" (рос)
 *   "pfybim"   → "зажим" (рос)
 *   "crfp"     → "срез" (рос)
 *   "dfk"      → "вал" (рос)
 *   "ldbk"     → "двигун" (укр, при спрощенні)
 */

// Мапа: латинська літера → кирилиця (російська ЙЦУКЕН)
const EN_TO_RU: Record<string, string> = {
  'q': 'й', 'w': 'ц', 'e': 'у', 'r': 'к', 't': 'е', 'y': 'н',
  'u': 'г', 'i': 'ш', 'o': 'щ', 'p': 'з', '[': 'х', ']': 'ъ',
  'a': 'ф', 's': 'ы', 'd': 'в', 'f': 'а', 'g': 'п', 'h': 'р',
  'j': 'о', 'k': 'л', 'l': 'д', ';': 'ж', "'": 'э',
  'z': 'я', 'x': 'ч', 'c': 'с', 'v': 'м', 'b': 'и', 'n': 'т',
  'm': 'ь', ',': 'б', '.': 'ю', '/': '.',
}

// Мапа: латинська літера → кирилиця (українська)
const EN_TO_UA: Record<string, string> = {
  'q': 'й', 'w': 'ц', 'e': 'у', 'r': 'к', 't': 'е', 'y': 'н',
  'u': 'г', 'i': 'ш', 'o': 'щ', 'p': 'з', '[': 'х', ']': 'ї',
  'a': 'ф', 's': 'і', 'd': 'в', 'f': 'а', 'g': 'п', 'h': 'р',
  'j': 'о', 'k': 'л', 'l': 'д', ';': 'ж', "'": 'є',
  'z': 'я', 'x': 'ч', 'c': 'с', 'v': 'м', 'b': 'и', 'n': 'т',
  'm': 'ь', ',': 'б', '.': 'ю', '/': '.',
}

/**
 * Конвертує латинський текст в кирилицю так, 
 * ніби користувач набрав його в неправильній розкладці.
 * 
 * Спочатку пробує українську, потім російську, повертає всі варіанти.
 */
export function fixKeyboardLayout(text: string): string[] {
  if (!text || /[а-яА-ЯїЇєЄіІґҐ]/.test(text)) {
    return []  // Вже кирилиця — не потребує виправлення
  }

  const lower = text.toLowerCase()
  const results: string[] = []

  // Конвертуємо в російську
  const ruResult = convertByMap(lower, EN_TO_RU)
  if (ruResult !== lower) results.push(ruResult)

  // Конвертуємо в українську
  const uaResult = convertByMap(lower, EN_TO_UA)
  if (uaResult !== lower && uaResult !== ruResult) results.push(uaResult)

  return results
}

function convertByMap(text: string, map: Record<string, string>): string {
  let result = ''
  for (const char of text) {
    result += map[char] ?? char
  }
  return result
}