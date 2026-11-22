/**
 * Чи людина зараз справді працює з цією вкладкою. Потрібно, щоб відкрита й забута вкладка вебу
 * не тримала головний ПК на частому опитуванні сервера цілий день (22.11.2026, ліміти сервера).
 */
export const USER_IDLE_MS = 3 * 60_000

let lastInput = Date.now()
let listening = false

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  const touch = () => { lastInput = Date.now() }
  for (const event of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) window.addEventListener(event, touch, { passive: true, capture: true })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) touch() })
}

export function isUserWatching(now = Date.now(), hidden = typeof document !== 'undefined' && document.hidden, idleMs = USER_IDLE_MS): boolean {
  listen()
  return !hidden && now - lastInput < idleMs
}
