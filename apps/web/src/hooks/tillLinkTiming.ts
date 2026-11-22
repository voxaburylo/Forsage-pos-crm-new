/** У вебі хтось працює — питаємо сервер часто. */
export const LINK_FAST_MS = 3_000
/** У вебі нікого немає — рідко: 120 запитів на годину замість 1 920. */
export const LINK_SLOW_MS = 30_000
/** Скільки тримаємо часте опитування після останньої роботи чи сигналу. */
export const LINK_FAST_HOLD_MS = 60_000
/** Сервер ще старий і не знає легкого запиту — працюємо як раніше. */
export const LINK_LEGACY_MS = 5_000

/** Коли наступного разу питати сервер, чи є для каси робота. */
export function nextBeatDelay(now: number, fastUntil: number, legacy: boolean): number {
  if (legacy) return LINK_LEGACY_MS
  return now < fastUntil ? LINK_FAST_MS : LINK_SLOW_MS
}
