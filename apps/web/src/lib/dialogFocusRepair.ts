import { desktopBridge } from './desktopBridge'

type DialogHost = { confirm: (message?: string) => boolean; alert: (message?: unknown) => void }

/**
 * 22.11.2026 (скарга власника: «у відкритому вікні нічого не вводиться»). Після системного вікна
 * confirm()/alert() програма на касі (Electron, Windows) лишається на екрані, але клавіатура більше не
 * потрапляє в поля, доки людина не перемкнеться на іншу програму й назад. У програмі таких вікон близько 60,
 * тому лагодимо в одному місці: одразу після кожного такого вікна просимо оболонку повернути фокус.
 * Відповідь вікна («Так»/«Скасувати») не змінюється. У браузері нічого не робить.
 */
export function installDialogFocusRepair(host: DialogHost = window, repair: () => void = () => desktopBridge()?.restoreInputFocus?.()): void {
  const guarded = host as DialogHost & { __forsageFocusRepair?: boolean }
  if (guarded.__forsageFocusRepair) return
  guarded.__forsageFocusRepair = true
  const nativeConfirm = host.confirm.bind(host), nativeAlert = host.alert.bind(host)
  const after = () => { try { repair() } catch { /* повернення фокуса не має ламати дію */ } }
  host.confirm = (message?: string) => { try { return nativeConfirm(message) } finally { after() } }
  host.alert = (message?: unknown) => { try { nativeAlert(message) } finally { after() } }
}
