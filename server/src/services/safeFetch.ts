import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Безпечне завантаження з інтернету (27.11.2026 винесено з aiProductPhotoService.ts без змін, щоб «Пошук фото з ШІ»
 * не тягнув за собою весь модуль помічника). Лише публічні https-адреси, кожне перенаправлення перевіряється заново.
 */
const FETCH_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 3

export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (kind === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower)
  }
  return true
}

type Resolver = (host: string) => Promise<Array<{ address: string }>>
const defaultResolver: Resolver = host => lookup(host, { all: true })

/** Лише публічні https-адреси; кожне перенаправлення перевіряється заново (захист від звернень у внутрішню мережу). */
export async function safeFetch(rawUrl: string, maxBytes: number, signal: AbortSignal, resolver: Resolver = defaultResolver, fetchImpl: typeof fetch = fetch): Promise<{ url: string; contentType: string; bytes: Buffer }> {
  let url = new URL(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Дозволено лише звичайні https-адреси')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Внутрішня адреса')
    const addresses = isIP(host) ? [{ address: host }] : await resolver(host)
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('Внутрішня адреса')
    const response = await fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForsageCatalog/1.0)', Accept: 'text/html,image/*;q=0.9,*/*;q=0.5' },
    })
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location')
      if (!next) throw new Error('Перенаправлення без адреси')
      url = new URL(next, url)
      continue
    }
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) throw new Error('Завеликий файл')
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length
      if (total > maxBytes) throw new Error('Завеликий файл')
      chunks.push(Buffer.from(chunk))
    }
    return { url: url.href, contentType: (response.headers.get('content-type') ?? '').toLowerCase(), bytes: Buffer.concat(chunks) }
  }
  throw new Error('Забагато перенаправлень')
}

export function imageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
