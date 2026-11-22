export const BACKUP_BUCKET = 'forsage-private-backups'
export const MAX_BACKUP_BYTES = 45 * 1024 * 1024

/**
 * Формат архіву копії. До 22.11.2026 — лише gzip; нові копії каса стискає Zstandard (на тій самій базі
 * 17,8 МБ замість 27,6 МБ: ліміт файлу в хмарі — 45 МБ). Старі копії лишаються й відновлюються як були.
 */
export type BackupFormat = 'gz' | 'zst'
export const BACKUP_FORMATS: readonly BackupFormat[] = ['gz', 'zst']
export const BACKUP_MIME_TYPES = ['application/gzip', 'application/zstd', 'application/json']
/** Маніфест перевіреної копії лежить поряд з архівом: `<id>-<sha256>.db.<gz|zst>.json`. */
export const VERIFIED_BACKUP_NAME = /^[a-f0-9-]{36}-[a-f0-9]{64}\.db\.(gz|zst)\.json$/i

export function backupFormatOfName(name: string): BackupFormat {
  return /\.db\.zst(\.json)?$/i.test(name) ? 'zst' : 'gz'
}

/** Чи починається файл як архів заявленого формату (перші байти). */
export function hasArchiveMagic(bytes: Uint8Array, format: BackupFormat): boolean {
  return format === 'zst'
    ? bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
    : bytes[0] === 0x1f && bytes[1] === 0x8b
}

export function backupDescriptor(body: any, tenantId: string) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const format: unknown = body?.format ?? 'gz'
  if (!uuid.test(tenantId) || !uuid.test(String(body?.device_id)) || !uuid.test(String(body?.id))
    || !/^[a-f0-9]{64}$/.test(String(body?.sha256))
    || !Number.isSafeInteger(body?.size_bytes) || body.size_bytes < 1 || body.size_bytes > MAX_BACKUP_BYTES
    || (format !== 'gz' && format !== 'zst')
    || body.tenant_id !== tenantId) throw new Error('Некоректні параметри резервної копії')
  return {
    id: body.id as string, device_id: body.device_id as string, tenant_id: tenantId,
    sha256: body.sha256 as string, size_bytes: body.size_bytes as number, format: format as BackupFormat,
    path: tenantId + '/' + body.device_id + '/' + body.id + '-' + body.sha256 + '.db.' + format,
  }
}

/**
 * Які перевірені копії лишати в хмарі (22.11.2026).
 *
 * Досі лишали сім найновіших — це від трьох днів до тижня. Якщо зіпсовані дані помітили пізніше
 * (так було зі стертими штрихкодами), у хмарі вже не було стану «до». Тепер, як у звичайних схемах
 * зберігання копій: сім останніх днів, по одній за кожен із чотирьох останніх тижнів і по одній
 * за кожен із шести останніх місяців — 17 копій, у безкоштовний обсяг сховища це вкладається.
 * За день, тиждень і місяць лишається найновіша копія. Найновіша копія лишається завжди.
 */
export const BACKUP_KEEP = { days: 7, weeks: 4, months: 6 } as const

const KYIV_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' })
const dayOf = (iso: string) => KYIV_DAY.format(new Date(iso))
/** Понеділок тижня, до якого належить день (РРРР-ММ-ДД). */
function weekOf(day: string): string {
  const date = new Date(day + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

export function backupsToKeep<T extends { name: string; created_at?: string | null }>(files: readonly T[], keep: { days: number; weeks: number; months: number } = BACKUP_KEEP): Set<string> {
  const dated = files.filter(file => file.created_at && Number.isFinite(Date.parse(file.created_at)))
    .sort((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!))
  const kept = new Set<string>()
  // Копії без дати не чіпаємо: краще зайвий файл, ніж видалити невідоме.
  for (const file of files) if (!dated.includes(file)) kept.add(file.name)
  const newestPer = (bucket: (day: string) => string, limit: number) => {
    const seen = new Set<string>()
    for (const file of dated) {
      const key = bucket(dayOf(file.created_at!))
      if (seen.has(key)) continue
      if (seen.size >= limit) break
      seen.add(key)
      kept.add(file.name)
    }
  }
  newestPer(day => day, keep.days)
  newestPer(weekOf, keep.weeks)
  newestPer(day => day.slice(0, 7), keep.months)
  if (dated[0]) kept.add(dated[0].name)
  return kept
}
