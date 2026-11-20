import type { ExternalBackupStatus } from '@/lib/desktopBridge'

export type ExternalBackupNotice = { tone: 'ok' | 'warn' | 'info'; text: string }

const DAY = 24 * 60 * 60_000
const moment = (value: string) => new Date(value).toLocaleString('uk-UA')

/** Що сказати власнику про копію на флешці. null — нагадувати нічого (для головного екрана). */
export function externalBackupNotice(status: ExternalBackupStatus, now = Date.now()): ExternalBackupNotice {
  if (!status.folder) return { tone: 'info', text: 'Флешку для копій не вибрано. Усі копії зараз лише на диску цього ПК.' }
  const last = status.last_copy_at ? Date.parse(status.last_copy_at) : NaN
  const age = Number.isFinite(last) ? Math.floor((now - last) / DAY) : null
  if (!status.available) {
    return { tone: status.stale ? 'warn' : 'info', text: age === null
      ? 'Вставте флешку з копіями: копію ще не записано.'
      : `Вставте флешку з копіями: остання копія — ${moment(status.last_copy_at!)}${age >= 1 ? ` (${age} дн. тому)` : ''}. Після підключення програма допише копію сама.` }
  }
  if (status.last_error && status.stale) return { tone: 'warn', text: `Копію на флешку не записано: ${status.last_error}` }
  if (status.stale) return { tone: 'warn', text: age === null ? 'Копію на флешку ще не записано.' : `Остання копія на флешці — ${age} дн. тому.` }
  return { tone: 'ok', text: `Остання копія на флешці: ${moment(status.last_copy_at!)}.` }
}

/** Нагадування на головному екрані — лише коли є що робити. */
export function externalBackupReminder(status: ExternalBackupStatus | null, now = Date.now()): string | null {
  if (!status?.folder) return null
  const notice = externalBackupNotice(status, now)
  return notice.tone === 'warn' ? notice.text : null
}
