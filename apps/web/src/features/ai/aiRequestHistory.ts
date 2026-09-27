import type { AiChatMessage } from './aiApi'

// The server accepts at most 40 messages. Keep the full local review/action journal separately.
export const MAX_AI_REQUEST_HISTORY = 40
export function aiRequestHistory(entries: readonly AiChatMessage[]): AiChatMessage[] {
  const recent = entries.filter(entry => ['user', 'model'].includes(entry.role) && typeof entry.text === 'string' && entry.text.trim())
    .slice(-MAX_AI_REQUEST_HISTORY)
    .map(({ role, text }) => ({ role, text }))
  // Gemini history must begin with a user turn, not an orphaned answer after trimming.
  const firstUser = recent.findIndex(entry => entry.role === 'user')
  return firstUser < 0 ? [] : recent.slice(firstUser)
}
