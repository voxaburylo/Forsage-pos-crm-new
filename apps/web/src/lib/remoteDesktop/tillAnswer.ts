/**
 * 22.11.2026. Головний ПК забрав запит вебу, але ще виконує дію (довга накладна, слабкий інтернет).
 * Веб чекає відповіді на ТОЙ САМИЙ запит за його номером і нічого не надсилає вдруге: порада
 * «спробуйте ще раз» могла виконати дію двічі.
 */
export type TillAnswerState =
  | { status: 'done'; result: unknown }
  | { status: 'failed'; error?: string }
  | { status: 'expired' }
  | { status: 'pending' }

export const TILL_ANSWER_POLL_MS = 2_000
/** Після цього веб чесно каже, що результату не знає, і просить перевірити на касі. */
export const TILL_ANSWER_MAX_MS = 150_000
export const TILL_ANSWER_UNKNOWN = 'Головний ПК ще не відповів. Перевірте результат на касі, перш ніж повторювати.'

export async function waitForTillAnswer(
  read: () => Promise<TillAnswerState>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxMs = TILL_ANSWER_MAX_MS,
  now: () => number = Date.now,
): Promise<unknown> {
  const deadline = now() + maxMs
  while (now() < deadline) {
    await sleep(TILL_ANSWER_POLL_MS)
    let state: TillAnswerState
    // Мережа блимнула — питаємо далі; сам запит на касу вдруге не йде.
    try { state = await read() } catch { continue }
    if (state.status === 'done') return state.result
    if (state.status === 'failed') throw new Error(state.error || 'Каса не змогла виконати дію')
    if (state.status === 'expired') throw new Error('Головний ПК не відповів. Дію не виконано — спробуйте ще раз.')
  }
  throw new Error(TILL_ANSWER_UNKNOWN)
}
