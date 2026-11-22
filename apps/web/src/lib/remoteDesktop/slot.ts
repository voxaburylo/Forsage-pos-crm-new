/** Місток до головного ПК, коли екран вебу працює через нього (див. remoteDesktop.ts). Без імпортів — без циклів. */
let current: unknown = null
export function setRemoteBridgeSlot(value: unknown): void { current = value }
export function remoteBridgeSlot(): unknown { return current }
