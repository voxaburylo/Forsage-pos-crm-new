const BLOCKED_SOURCE_DOMAINS = [
  'google.', 'bing.com', 'yahoo.', 'yandex.', 'duckduckgo.',
  'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com',
  'amazon.', 'ebay.', 'aliexpress.', 'prom.ua', 'rozetka.',
]

export function normalizeAiCatalogCode(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
}

export function isPlaceholderSku(value: string | null | undefined): boolean {
  return /^AUTO-/i.test(String(value ?? '').trim())
}

export function safeCatalogNumber(value: string | null | undefined): string | null {
  const normalized = normalizeAiCatalogCode(value)
  if (normalized.length < 4 || normalized.length > 40 || !/\d/.test(normalized)) return null
  if (/^(AUTO|POS)/.test(normalized)) return null
  if (/^\d{8}$|^\d{12,14}$/.test(normalized)) return null
  if (/^\d{1,2}W\d{1,2}$/.test(normalized)) return null
  if (/^\d+(?:ML|L|KG|G|MM|CM|M|V|W|A|AH|C)$/.test(normalized)) return null
  return normalized
}

export function evidenceDomain(value: string | null | undefined): string | null {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!host || BLOCKED_SOURCE_DOMAINS.some((blocked) => host === blocked || host.includes(blocked))) return null
    return host
  } catch {
    return null
  }
}

export function groundedSourceLabel(
  title: string | null | undefined,
  uri: string | null | undefined,
): string | null {
  const directDomain = evidenceDomain(uri)
  if (directDomain) return directDomain

  try {
    const host = new URL(String(uri ?? '')).hostname.toLowerCase()
    if (host !== 'vertexaisearch.cloud.google.com') return null
  } catch {
    return null
  }

  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim()
  const normalizedTitle = cleanTitle.toLowerCase()
  if (!cleanTitle || BLOCKED_SOURCE_DOMAINS.some((blocked) => normalizedTitle.includes(blocked))) return null
  return cleanTitle.slice(0, 120)
}
export function normalizedNameContains(name: string, catalogNumber: string): boolean {
  return normalizeAiCatalogCode(name).includes(catalogNumber)
}
