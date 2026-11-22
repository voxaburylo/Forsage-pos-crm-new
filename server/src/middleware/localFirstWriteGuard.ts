import type { NextFunction, Request, Response } from 'express'

/**
 * Змінювати дані можна лише на касі.
 *
 * Рішення власника (06.09.2026): «локальна база єдина, щоб не було плутанини».
 * Через веб дозволено дивитися продажі, аналітику, шукати й переглядати товари.
 * Продавати, правити картки, проводити накладні й робити ревізію — тільки на
 * касі, і звідти зміни їдуть на сервер чергою.
 *
 * Причина не в безпеці, а в порядку: дві точки запису в ту саму базу
 * неминуче дають розбіжність, і ми її вже бачили — залишки, які «не сходяться».
 * Одна точка запису прибирає цілий клас проблем.
 *
 * Тому сервер приймає зміну лише тоді, коли вона:
 *   • надіслана самою касою, включно з її чергою синхронізації
 *     (заголовок `X-Forsage-Client: desktop`), або
 *   • стосується входу, вебхуків і службових задач, які взагалі не про дані
 *     магазину.
 *
 * Заголовок — не захист від зловмисника (його неважко підробити), а захист від
 * випадковості: щоб ніхто не змінив залишок з телефона, думаючи, що це те
 * саме, що й на касі. Справжній захист лишається на автентифікації й ролях.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const WEB_SESSION_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
])

/**
 * Шляхи, де запис дозволений завжди: вони не стосуються даних магазину.
 */
const ALWAYS_WRITABLE = [
  '/api/v1/telegram/',    // вебхук Telegram: пише не людина, а месенджер
  '/api/v1/internal/',    // щоденні службові задачі за секретом
  '/api/v1/jobs/',        // те саме
]

/**
 * Команда на касу з вебу (правка картки, закриття забутої зміни). Це не запис у дані магазину:
 * сервер лише кладе доручення, а виконує його програма на касі у своїй базі — точка запису лишається одна.
 * Дозволено рівно створення команди; «забрати» й «відповісти» робить тільки каса (заголовок нижче).
 */
const WEB_TILL_COMMAND_PATH = '/api/v1/till-commands'
/**
 * 22.11.2026 (етап 8): розпізнавання фото накладної з телефона. Запит нічого не пише в дані магазину —
 * він лише читає фото й повертає рядки; далі вони їдуть на касу командою. Витрати ШІ рахуються як завжди.
 */
const WEB_INVOICE_PHOTO_PATH = '/api/v1/ai/supply-invoice-photo'
/**
 * 22.11.2026 (рішення власника «веб повний, але тільки через головний ПК»): запит вебу до головного ПК.
 * Сервер лише передає його касі; виконує каса у своїй базі з правами працівника — точка запису одна.
 */
const WEB_TILL_RPC_PATH = '/api/v1/till-rpc'
/**
 * 22.11.2026: ШІ-помічник у вебі. Розмова й пропозиції лише читають дані; застосувати дію (накладна, замовлення)
 * веб може тільки через головний ПК. Правила помічника — налаштування, що не стосуються залишків і грошей.
 */
const WEB_AI_READ_PATHS = new Set(['/api/v1/ai/chat', '/api/v1/ai/catalog-review'])
const WEB_AI_MEMORY_PATH = '/api/v1/ai/memory'
/**
 * 22.11.2026 (рішення власника: «зміна тієї інформації, яка не вплине на залишки»): дані, що живуть лише на сервері —
 * у базі каси їх немає взагалі, тож задвоїтись нема чому: лист очікування, сповіщення та їх шаблони, канали, чати.
 */
const SERVER_ONLY_DATA_PREFIXES = ['/api/v1/waitlist/', '/api/v1/notifications/', '/api/v1/channels', '/api/v1/chats/', '/api/v1/settings/owner-alerts']

export function isStaffSecretChange(method: string, path: string): boolean {
  return (method === 'POST' && path === '/api/v1/auth/set-pin') || (method === 'PUT' && /^\/api\/v1\/admin\/users\/[0-9a-f-]{36}\/password$/.test(path))
}

export const DESKTOP_CLIENT_HEADER = 'x-forsage-client'
export const DESKTOP_CLIENT_VALUE = 'desktop'

export function isWriteAllowed(req: Pick<Request, 'method' | 'path' | 'get'>): boolean {
  if (SAFE_METHODS.has(req.method)) return true
  if (WEB_SESSION_PATHS.has(req.path)) return true
  if (ALWAYS_WRITABLE.some((prefix) => req.path.startsWith(prefix))) return true
  if (req.method === 'POST' && (req.path === WEB_TILL_COMMAND_PATH || req.path === WEB_TILL_COMMAND_PATH + '/')) return true
  if (req.method === 'POST' && req.path === WEB_INVOICE_PHOTO_PATH) return true
  if (req.method === 'POST' && (req.path === WEB_TILL_RPC_PATH || req.path === WEB_TILL_RPC_PATH + '/')) return true
  if (req.method === 'POST' && WEB_AI_READ_PATHS.has(req.path)) return true
  // 22.11.2026: PIN і пароль працівника — із вебу навіть без головного ПК; касі сервер передає лише хеш.
  if (isStaffSecretChange(req.method, req.path)) return true
  if (SERVER_ONLY_DATA_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) return true
  if ((req.method === 'POST' && req.path === WEB_AI_MEMORY_PATH) || (req.method === 'DELETE' && req.path.startsWith(WEB_AI_MEMORY_PATH + '/'))) return true
  return req.get(DESKTOP_CLIENT_HEADER) === DESKTOP_CLIENT_VALUE
}

export function localFirstWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (isWriteAllowed(req)) { next(); return }

  res.status(403).json({
    error: {
      code: 'WEB_IS_READ_ONLY',
      message: 'Через веб можна тільки дивитися. Продажі, зміни й ревізію робіть на касі — звідти вони самі приїдуть сюди.',
    },
  })
}
