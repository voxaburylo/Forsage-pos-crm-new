import type { AiChatMessage } from './aiApi'

// The server accepts at most 40 messages. Keep the full local review/action journal separately.
export const MAX_AI_REQUEST_HISTORY = 40
export function aiRequestHistory(entries: readonly AiChatMessage[]): AiChatMessage[] {
  const recent = entries.filter(entry => ['user', 'model'].includes(entry.role) && typeof entry.text === 'string' && entry.text.trim())
    .slice(-MAX_AI_REQUEST_HISTORY)
    .map(({ role, text }) => ({ role, text }))
  // Model history must begin with a user turn, not an orphaned answer after trimming.
  const firstUser = recent.findIndex(entry => entry.role === 'user')
  return firstUser < 0 ? [] : recent.slice(firstUser)
}

/**
 * 26.11.2026: помічник не знав, чим закінчилась його пропозиція, і пропонував ті самі пари дублів, у яких каса вже
 * відмовила (чат власника: тричі поспіль «найди дубли» — той самий список). До відповіді помічника в історії запиту
 * дописується підсумок: що власник підтвердив, що відхилив і чому каса не записала. На екрані текст не змінюється.
 */
export interface AiActionOutcomes {
  applied: Readonly<Record<string, string | undefined>>
  applyMsg: Readonly<Record<string, string | undefined>>
  applyErrors: Readonly<Record<string, ReadonlyArray<{ item: string; error: string }> | undefined>>
}
const OUTCOME_LIMIT = 1500
export function actionOutcomeNote(actions: ReadonlyArray<{ id: string; title?: string }> | undefined, outcomes: AiActionOutcomes): string {
  const notes = (actions ?? []).map(action => {
    const state = outcomes.applied[action.id]
    if (state === 'rejected') return `Пропозицію «${action.title ?? ''}» власник відхилив.`
    if (state !== 'ok') return `Пропозицію «${action.title ?? ''}» власник ще не підтвердив.`
    const errors = (outcomes.applyErrors[action.id] ?? []).slice(0, 12).map(row => `${row.item} — ${row.error}`).join('; ')
    return `Власник підтвердив «${action.title ?? ''}». Каса: ${outcomes.applyMsg[action.id] ?? 'записано'}` + (errors ? ` Каса не записала: ${errors}` : '')
  })
  return notes.length ? ('\n\n[Підсумок програми для помічника, власник цього не бачить: ' + notes.join(' ')).slice(0, OUTCOME_LIMIT) + ']' : ''
}
export function aiRequestHistoryWithOutcomes(
  entries: ReadonlyArray<AiChatMessage & { actions?: ReadonlyArray<{ id: string; title?: string }> }>, outcomes: AiActionOutcomes,
): AiChatMessage[] {
  return aiRequestHistory(entries.map(entry => entry.role === 'model' && entry.actions?.length && entry.text?.trim()
    ? { role: entry.role, text: entry.text + actionOutcomeNote(entry.actions, outcomes) } : entry))
}
