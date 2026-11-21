/**
 * Гарячі клавіші каси (21.11.2026, план «каса без мишки»). F5 (оновлення), F7 (префікс сканера),
 * F11 (повний екран) і F12 не займаємо.
 */
export type PosHotkey = 'pay' | 'customer' | 'suspend' | 'suspended' | 'find-receipt' | 'help'

export function posHotkeyAction(key: string, hasItems: boolean): PosHotkey | null {
  switch (key) {
    case 'F1': return 'help'
    case 'F2': return hasItems ? 'pay' : null
    case 'F3': return 'customer'
    case 'F4': return hasItems ? 'suspend' : null
    case 'F8': return 'suspended'
    case 'F9': return 'find-receipt'
    default: return null
  }
}
