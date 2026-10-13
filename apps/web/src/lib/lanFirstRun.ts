import { desktopBridge, isDesktopRuntime, type DesktopLanDiscoveredHub, type DesktopLanFirstRunStatus } from './desktopBridge'

const STATUS_TIMEOUT_MS = 5000

/** Absent API means an older desktop build. A failed current API is not proof
 * that this is the main PC and must never enable a cloud-login fallback. */
export async function readLanFirstRunStatus(): Promise<DesktopLanFirstRunStatus | null> {
  const read = desktopBridge()?.lan?.firstRunStatus
  if (!read) return null
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await Promise.race([
      read(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('STATUS_TIMEOUT')), STATUS_TIMEOUT_MS) }),
    ])
    if (!status || !['standalone', 'hub', 'client'].includes(status.mode)
      || typeof status.canPair !== 'boolean' || typeof status.configured !== 'boolean') throw new Error('INVALID_STATUS')
    return { mode: status.mode, configured: status.configured, canPair: status.canPair }
  } catch {
    throw new Error('Не вдалося перевірити підключення цього ПК. Повторіть перевірку; хмарний вхід не запускався.')
  } finally { if (timeout) clearTimeout(timeout) }
}

export function lanNeedsSetup(status: DesktopLanFirstRunStatus | null): boolean {
  return Boolean(status?.canPair || (status?.mode === 'client' && !status.configured))
}

/** Only the main/standalone PC owns the cloud mirror. A LAN workstation's
 * cached identity and order queue must never become an independent cloud source. */
export async function canUseCloudBackground(): Promise<boolean> {
  if (!isDesktopRuntime()) return true
  try {
    const status = await readLanFirstRunStatus()
    return !status || (status.mode !== 'client' && !status.canPair)
  } catch { return false }
}

/** Discovery names are only hints. The main process validates the address and
 * connection code before persisting configuration or exposing any store data. */
export function normalizeDiscoveredHubs(value: unknown): DesktopLanDiscoveredHub[] {
  if (!Array.isArray(value)) throw new Error('Не вдалося прочитати результат пошуку головного ПК')
  const seen = new Set<string>()
  const hubs: DesktopLanDiscoveredHub[] = []
  for (const row of value) {
    if (!row || typeof row.address !== 'string' || !row.address.trim() || typeof row.name !== 'string') continue
    const address = row.address.trim()
    if (seen.has(address)) continue
    seen.add(address)
    hubs.push({ address, name: row.name.trim() || 'Головний ПК' })
    if (hubs.length >= 32) break
  }
  return hubs
}

export function lanPairInput(hubAddress: string, accessKey: string, port: string) {
  const address = hubAddress.trim(), key = accessKey.trim()
  if (!address) throw new Error('Виберіть головний ПК або введіть його адресу')
  if (!key) throw new Error('Введіть код підключення з головного ПК')
  const number = port.trim() ? Number(port) : undefined
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1024 || number > 65535)) {
    throw new Error('Порт має бути цілим числом від 1024 до 65535')
  }
  return { hubAddress: address, accessKey: key, ...(number === undefined ? {} : { port: number }) }
}
