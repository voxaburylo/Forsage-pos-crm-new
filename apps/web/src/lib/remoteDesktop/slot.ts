/** Місток до головного ПК, коли екран вебу працює через нього (див. remoteDesktop.ts). Без імпортів — без циклів. */
let current: unknown = null
const listeners = new Set<() => void>()
export function setRemoteBridgeSlot(value: unknown): void {
  if (current === value) return
  current = value
  // 23.11.2026: екрани перемальовуються, щойно місток з'явився чи зник (useWritesToMainPc).
  for (const listener of [...listeners]) listener()
}
export function remoteBridgeSlot(): unknown { return current }
export function subscribeRemoteBridgeSlot(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
