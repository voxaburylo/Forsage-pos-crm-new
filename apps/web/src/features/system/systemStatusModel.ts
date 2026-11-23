/**
 * 23.11.2026 (план T2): «Стан системи» — простими словами для власника, без технічних назв.
 * Кожен рядок має один із трьох станів: гаразд, увага, біда. Чого не знаємо — так і кажемо, а не «гаразд».
 */
export type Level = 'ok' | 'warn' | 'bad' | 'unknown'
export type StatusLine = { id: string; label: string; value: string; level: Level; hint?: string }

export type TillReport = {
  version: string | null; release_id: string | null; built_at: string | null
  mode: 'window' | 'background'; role: 'main' | 'manager'
  disk_free_bytes: number | null; disk_total_bytes: number | null; database_bytes: number | null
  local_backup_at: string | null; cloud_backup_at: string | null; external_backup_at: string | null
  schema_version: number | null; started_at: string | null
  check_at?: string | null; check_findings?: Array<{ code: string; title: string; count: number }>
  manager_release_id?: string | null; manager_seen_at?: string | null
}
export type SystemStatus = {
  server: { build: string | null; time: string }
  till: {
    seen_at: string | null; online: boolean; offline_minutes: number | null
    outbox: { waiting: number; oldest_at: string | null; error: string | null; reported_at: string | null } | null
    report: TillReport | null; reported_at: string | null
  }
  errors: { last_day: number; rows: Array<{ created_at: string; source: string; route: string | null; code: string | null; message: string; repeats: number }> }
}

/** Копія бази старша за це — увага; старша за тиждень — біда. */
export const BACKUP_WARN_HOURS = 36
export const BACKUP_BAD_HOURS = 7 * 24
/** Вільного місця менше за це — увага / біда. */
export const DISK_WARN_BYTES = 10 * 1024 ** 3
export const DISK_BAD_BYTES = 2 * 1024 ** 3
/** Документ чекає передачі довше за це — увага (стільки ж чекає тривога в Telegram). */
export const OUTBOX_WARN_MINUTES = 30
/** Нічна перевірка не запускалась довше за це — увага (програма вночі не працювала?). */
export const NIGHTLY_STALE_HOURS = 72
/** Знахідки, що означають пошкодження бази, а не розбіжність в обліку. */
const DAMAGE_CODES = ['nightly-db-file', 'nightly-db-references', 'nightly-fiscal-stuck']

export function ago(iso: string | null, now: number): string {
  if (!iso) return 'невідомо'
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (!Number.isFinite(minutes)) return 'невідомо'
  if (minutes < 1) return 'щойно'
  if (minutes < 60) return `${minutes} хв тому`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} год тому`
  return `${Math.floor(hours / 24)} дн тому`
}

export function bytesText(bytes: number | null): string {
  if (bytes === null) return 'невідомо'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`
}

const hoursSince = (iso: string | null, now: number) => iso ? (now - new Date(iso).getTime()) / 3_600_000 : null

function backupLine(id: string, label: string, at: string | null, now: number, optional = false): StatusLine {
  const hours = hoursSince(at, now)
  if (hours === null || !Number.isFinite(hours)) {
    return { id, label, value: optional ? 'не налаштовано' : 'копій ще не було', level: optional ? 'unknown' : 'bad' }
  }
  return { id, label, value: ago(at, now), level: hours > BACKUP_BAD_HOURS ? 'bad' : hours > BACKUP_WARN_HOURS ? 'warn' : 'ok' }
}

/**
 * 23.11.2026 (план T7): версія ПК менеджера. Головний ПК бачить її, коли менеджер працює через нього.
 * Інша збірка, ніж на касі, — попередження: дані й команди можуть розходитися.
 */
export function managerPcLine(report: TillReport, now: number): StatusLine {
  const label = 'Версія ПК менеджера'
  if (!report.manager_seen_at) return { id: 'manager-pc', label, value: 'ще не звертався після запуску каси', level: 'unknown' }
  const seen = `звертався ${ago(report.manager_seen_at, now)}`
  if (!report.manager_release_id) return { id: 'manager-pc', label, value: 'стара програма (версію не повідомляє)', level: 'warn', hint: seen + '. Оновіть ПК менеджера.' }
  if (report.release_id && report.manager_release_id !== report.release_id) {
    return { id: 'manager-pc', label, value: report.manager_release_id, level: 'warn', hint: seen + '. Відрізняється від каси — оновіть ПК менеджера.' }
  }
  return { id: 'manager-pc', label, value: report.manager_release_id, level: 'ok', hint: seen }
}

export function statusLines(status: SystemStatus, now: number): StatusLine[] {
  const lines: StatusLine[] = []
  const { till } = status
  lines.push(!till.seen_at
    ? { id: 'link', label: 'Головний ПК', value: 'ще не виходив на звʼязок', level: 'bad' }
    : till.online
      ? { id: 'link', label: 'Головний ПК', value: 'на звʼязку', level: 'ok', hint: `озивався ${ago(till.seen_at, now)}` }
      : { id: 'link', label: 'Головний ПК', value: `не на звʼязку — ${ago(till.seen_at, now)}`, level: 'bad', hint: 'Веб зараз лише для перегляду. Перевірте, чи ввімкнено компʼютер і чи є інтернет.' })

  const report = till.report
  if (!report) {
    lines.push({ id: 'report', label: 'Програма на касі', value: 'відомостей ще немає', level: 'unknown', hint: 'Зʼявляться після оновлення програми на головному ПК.' })
  } else {
    lines.push({ id: 'mode', label: 'Програма на касі', value: report.mode === 'background' ? 'працює у фоні (вікно закрите)' : 'вікно відкрите', level: 'ok',
      hint: till.reported_at ? `відомості ${ago(till.reported_at, now)}` : undefined })
    lines.push({ id: 'version', label: 'Версія каси', value: [report.version, report.release_id].filter(Boolean).join(' · ') || 'невідомо', level: report.release_id ? 'ok' : 'unknown',
      hint: report.built_at ? `зібрано ${new Date(report.built_at).toLocaleDateString('uk-UA')}` : undefined })
    lines.push(managerPcLine(report, now))
  }

  const outbox = till.outbox
  if (!outbox) lines.push({ id: 'outbox', label: 'Передача на сервер', value: 'відомостей ще немає', level: 'unknown' })
  else if (outbox.waiting === 0) lines.push({ id: 'outbox', label: 'Передача на сервер', value: 'усе передано', level: 'ok' })
  else {
    const waitingMinutes = outbox.oldest_at ? (now - new Date(outbox.oldest_at).getTime()) / 60_000 : 0
    lines.push({ id: 'outbox', label: 'Передача на сервер', value: `чекає документів: ${outbox.waiting}${outbox.oldest_at ? `, найстаріший — ${ago(outbox.oldest_at, now)}` : ''}`,
      level: outbox.error ? 'bad' : waitingMinutes > OUTBOX_WARN_MINUTES ? 'warn' : 'ok', hint: outbox.error ?? undefined })
  }

  if (report) {
    lines.push(backupLine('backup-cloud', 'Копія бази в хмарі', report.cloud_backup_at, now))
    lines.push(backupLine('backup-local', 'Копія бази на цьому ПК', report.local_backup_at, now))
    lines.push(backupLine('backup-external', 'Копія на флешці', report.external_backup_at, now, true))
    const free = report.disk_free_bytes
    lines.push({ id: 'disk', label: 'Вільне місце на диску', value: bytesText(free), level: free === null ? 'unknown' : free < DISK_BAD_BYTES ? 'bad' : free < DISK_WARN_BYTES ? 'warn' : 'ok',
      hint: report.database_bytes !== null ? `база займає ${bytesText(report.database_bytes)}` : undefined })
  }

  // План T6: нічна перевірка бази каси. Програма лише повідомляє — нічого не виправляє сама.
  if (report) {
    const found = report.check_findings ?? []
    const checkHours = hoursSince(report.check_at ?? null, now)
    if (checkHours === null || !Number.isFinite(checkHours)) lines.push({ id: 'check', label: 'Нічна перевірка бази', value: 'ще не виконувалась', level: 'unknown' })
    else if (found.length === 0) lines.push({ id: 'check', label: 'Нічна перевірка бази', value: 'розбіжностей немає', level: checkHours > NIGHTLY_STALE_HOURS ? 'warn' : 'ok', hint: `перевірено ${ago(report.check_at ?? null, now)}` })
    else lines.push({ id: 'check', label: 'Нічна перевірка бази', value: found.map(item => `${item.title}: ${item.count}`).join('; '), level: found.some(item => DAMAGE_CODES.includes(item.code)) ? 'bad' : 'warn',
      hint: `перевірено ${ago(report.check_at ?? null, now)}. Подробиці — на касі: «Налаштування» → «ПК і копії» → «Журнал проблем».` })
  }

  lines.push(status.errors.last_day === 0
    ? { id: 'errors', label: 'Помилки сервера за добу', value: 'не було', level: 'ok' }
    : { id: 'errors', label: 'Помилки сервера за добу', value: String(status.errors.last_day), level: status.errors.last_day >= 10 ? 'bad' : 'warn', hint: 'Список нижче — покажіть його Claude.' })
  return lines
}

/** Один підсумок угорі екрана. */
export function overallLevel(lines: StatusLine[]): Level {
  if (lines.some(line => line.level === 'bad')) return 'bad'
  if (lines.some(line => line.level === 'warn')) return 'warn'
  // ПК менеджера, який ще не звертався (вимкнений), — не привід писати «невідомо» про всю систему.
  return lines.some(line => line.level === 'unknown' && line.id !== 'manager-pc') ? 'unknown' : 'ok'
}

export const OVERALL_TEXT: Record<Level, string> = {
  ok: 'Усе працює',
  warn: 'Працює, але є на що глянути',
  bad: 'Потрібна увага',
  unknown: 'Працює; частини відомостей ще немає',
}
