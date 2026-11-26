/**
 * 26.11.2026 (аудит): на Vercel функція «засинає» одразу після відповіді — робота, яку запустили й не дочекались
 * (запис помилки в базу), просто не виконувалась: за три дні в server_errors не зʼявилось жодного рядка.
 * keepAlive каже платформі дочекатися цієї роботи. Поза Vercel (тести, свій сервер) робота й так доходить до кінця.
 * Без залежності: це той самий механізм, яким користується @vercel/functions (waitUntil).
 */
type RequestContext = { waitUntil?: (work: Promise<unknown>) => void }

export function keepAlive(work: Promise<unknown>): void {
  const settled = work.catch(() => undefined)
  try {
    const store = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as { get?: () => RequestContext | undefined } | undefined
    store?.get?.()?.waitUntil?.(settled)
  } catch { /* поза Vercel нічого робити не треба */ }
}
