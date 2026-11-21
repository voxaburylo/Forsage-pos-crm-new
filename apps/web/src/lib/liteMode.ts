/**
 * 21.11.2026 (план: старий ПК на Windows 10). У програмі на Windows відеокарту вимкнено через старі
 * драйвери, тож усе малює процесор — і на слабкому ПК гальмують анімації, тіні та розмиття.
 * Полегшений режим їх прибирає. Вмикається сам на слабкому ПК (≤ 4 ядра або ≤ 4 ГБ пам'яті) або вручну.
 */
export type LiteModeSetting = 'auto' | 'on' | 'off'
const KEY = 'forsage.liteMode'

export function readLiteModeSetting(): LiteModeSetting {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'on' || value === 'off' ? value : 'auto'
  } catch { return 'auto' }
}

export function weakDevice(nav: { hardwareConcurrency?: number; deviceMemory?: number } = navigator as never): boolean {
  const cores = nav.hardwareConcurrency ?? 8
  const memory = nav.deviceMemory ?? 8
  return cores <= 4 || memory <= 4
}

export function liteModeActive(setting: LiteModeSetting = readLiteModeSetting(), nav?: { hardwareConcurrency?: number; deviceMemory?: number }): boolean {
  if (setting === 'on') return true
  if (setting === 'off') return false
  return weakDevice(nav)
}

export function applyLiteMode(setting: LiteModeSetting = readLiteModeSetting()): boolean {
  const active = liteModeActive(setting)
  document.documentElement.classList.toggle('lite-mode', active)
  return active
}

export function saveLiteModeSetting(setting: LiteModeSetting): boolean {
  try { window.localStorage.setItem(KEY, setting) } catch { /* optional */ }
  return applyLiteMode(setting)
}
