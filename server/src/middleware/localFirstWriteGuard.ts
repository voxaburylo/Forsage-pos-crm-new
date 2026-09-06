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

export const DESKTOP_CLIENT_HEADER = 'x-forsage-client'
export const DESKTOP_CLIENT_VALUE = 'desktop'

export function isWriteAllowed(req: Pick<Request, 'method' | 'path' | 'get'>): boolean {
  if (SAFE_METHODS.has(req.method)) return true
  if (WEB_SESSION_PATHS.has(req.path)) return true
  if (ALWAYS_WRITABLE.some((prefix) => req.path.startsWith(prefix))) return true
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
