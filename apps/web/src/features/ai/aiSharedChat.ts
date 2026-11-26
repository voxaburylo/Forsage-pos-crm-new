import { useEffect, useLayoutEffect, useRef } from 'react'
import { api } from '@/lib/api'

/**
 * 26.11.2026, слово власника: «потім зайшов — і на будь-якому пристрої однаковий чат; щоб не було на телефоні
 * у вебі один, а на компʼютері інший». Чат, як і раніше, лежить у памʼяті пристрою (працює й без інтернету),
 * але ще й на сервері. Пристрій бере новішу версію: при відкритті, при поверненні на вкладку й раз на 30 с.
 * Відповідь, яку сервер дорахував після того, як телефон згорнули, сервер сам дописує в чат (за номером запиту rid).
 */
export type SharedChatEntry = { role: 'user' | 'model'; text: string; rid?: string }
export type SharedChatState = { entries: SharedChatEntry[]; applied: Record<string, unknown>; applyMsg: Record<string, unknown>; applyStatus: Record<string, unknown>; applyErrors: Record<string, unknown>; savedAt?: number }

export const sharedChatApi = {
  get: (kind: string) => api.get<{ data: SharedChatState | null }>('/api/v1/ai/chat-state?kind=' + kind, { silent: true, timeoutMs: 15_000 }),
  put: (kind: string, state: SharedChatState) => api.put<{ data: { accepted: boolean; state: SharedChatState | null } }>('/api/v1/ai/chat-state?kind=' + kind, { state }, { silent: true, timeoutMs: 20_000 }),
}

/** Одна відповідь — один раз: та сама репліка з тим самим номером запиту (з сервера й з екрана) не дублюється. */
export function dedupeChatEntries<T extends { role: string; rid?: unknown }>(entries: readonly T[]): T[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    if (typeof entry.rid !== 'string' || !entry.rid) return true
    const key = entry.role + ':' + entry.rid
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Час останнього збереження чату на цьому пристрої (його пише екран разом із чатом). */
export function localSavedAt(storageKey: string, storage: Pick<Storage, 'getItem'> = localStorage): number {
  try { return Number(JSON.parse(storage.getItem(storageKey) ?? '{}')?.savedAt) || 0 } catch { return 0 }
}

export const SHARED_CHAT_POLL_MS = 30_000
export const SHARED_CHAT_SAVE_DELAY_MS = 1_500

export function useSharedAiChat(options: {
  kind: 'assistant' | 'invoice'
  enabled: boolean
  storageKey: string
  snapshot: SharedChatState
  /** Іде запит чи застосування — чужу версію зараз не підставляємо, щоб не загубити те, що відбувається. */
  busy: () => boolean
  adopt: (state: SharedChatState) => void
}) {
  const { kind, enabled, storageKey, snapshot } = options
  const seen = useRef(localSavedAt(storageKey))
  const adopted = useRef(false)
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    const pull = async () => {
      if (stopped || document.visibilityState !== 'visible' || latest.current.busy()) return
      const remote = await sharedChatApi.get(kind).then(result => result.data, () => null)
      if (stopped || !remote || !(Number(remote.savedAt) > seen.current) || latest.current.busy()) return
      seen.current = Number(remote.savedAt)
      adopted.current = true
      latest.current.adopt({ ...remote, entries: dedupeChatEntries(remote.entries ?? []) })
    }
    void pull()
    const timer = window.setInterval(() => { void pull() }, SHARED_CHAT_POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void pull() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [enabled, kind])

  const first = useRef(true)
  useEffect(() => {
    if (!enabled) return
    // Чат, яким екран відкрився, не відправляємо: він міг застаріти, а на сервері — новіша розмова з іншого пристрою.
    // Відправляємо лише те, що змінилося тут, після відкриття.
    if (first.current) { first.current = false; return }
    // Щойно підставили версію з сервера — назад її не відправляємо (інакше пристрої «перекидались» би нею).
    if (adopted.current) { adopted.current = false; return }
    const timer = window.setTimeout(() => {
      const savedAt = Math.max(Date.now(), seen.current + 1)
      void sharedChatApi.put(kind, { ...snapshot, entries: snapshot.entries.slice(-80), savedAt }).then(result => {
        if (result.data.accepted) { seen.current = savedAt; return }
        const remote = result.data.state
        if (remote && Number(remote.savedAt) > seen.current && !latest.current.busy()) {
          seen.current = Number(remote.savedAt)
          adopted.current = true
          latest.current.adopt({ ...remote, entries: dedupeChatEntries(remote.entries ?? []) })
        }
      }, () => undefined)
    }, SHARED_CHAT_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, kind, snapshot])
}
