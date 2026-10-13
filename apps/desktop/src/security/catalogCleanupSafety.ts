export interface CleanupCapability { available: boolean; reason?: string }
export async function checkCleanupCapability(apiUrl: string, accessToken: string | undefined,
  fetcher: (url: string, init: RequestInit) => Promise<Response>): Promise<CleanupCapability> {
  if (!accessToken) return { available: false, reason: 'Для першого злиття потрібна чинна серверна сесія адміністратора. Сканування працює локально.' }
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10_000)
  try {
    const url = new URL(apiUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('CONFIG')
    const response = await fetcher(url.toString().replace(/\/$/, '') + '/api/v1/sync/capabilities', {
      headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: abort.signal,
    })
    if (!response.ok) throw Error('UNAVAILABLE')
    const value = await response.json() as { data?: { catalog_cleanup?: unknown } }
    if (value?.data?.catalog_cleanup !== 1) throw Error('VERSION')
    return { available: true }
  } catch {
    return { available: false, reason: 'Сервер не підтвердив сумісну версію злиття. Сканування доступне; запис заблоковано до перевірки зв’язку й оновлення сервера.' }
  } finally { clearTimeout(timer) }
}

/** Only native main reads these entries directly from the app's renderer. No renderer noCart boolean. */
export function cleanupCartBlockers(entries: unknown, productIds: string[]): string[] {
  const blocked = 'Товар є у відкритому чеку. Завершіть або очистіть цей чек перед злиттям.'
  const unavailable = 'Не вдалося перевірити збережені відкриті чеки. Злиття не виконано.'
  if (!Array.isArray(entries) || entries.length > 1000) return [unavailable]
  const ids = new Set(productIds)
  function contains(value: unknown, depth = 0): boolean {
    if (depth > 30) throw Error('DEPTH')
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => (/^product_?id$/i.test(key) && typeof child === 'string' && ids.has(child)) || contains(child, depth + 1))
  }
  try {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
        || entry[1].length > 10_000_000) throw Error('INVALID')
      if (!/^forsage_pos_(?:open_receipts_v2:|cart$)/.test(entry[0])) throw Error('KEY')
      const saved: unknown = JSON.parse(entry[1])
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !('tabs' in saved) || !Array.isArray(saved.tabs)
        || saved.tabs.some(tab => !tab || typeof tab !== 'object' || !Array.isArray(tab.items)
          || tab.items.some((item: unknown) => !item || typeof item !== 'object' || !('productId' in item)
            || typeof item.productId !== 'string' || !item.productId))) throw Error('SHAPE')
      if (contains(saved)) return [blocked]
    }
    return []
  } catch { return [unavailable] }
}
