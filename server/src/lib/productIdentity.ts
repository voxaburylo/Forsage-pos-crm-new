export function normalizeExactBarcode(value: unknown): string | null {
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (!raw) return null
  const compact = raw.replace(/[\s\u00a0\u202f-]/g, '').replace(',', '.')
  if (/^\d+\.0+$/.test(compact)) return compact.replace(/\.0+$/, '')
  if (/^\d+(?:\.\d+)?e\+\d+$/i.test(compact)) {
    const numeric = Number(compact)
    if (Number.isSafeInteger(numeric)) return String(numeric)
  }
  return compact
}

export function normalizeExactProductName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('uk-UA')
    .replace(/ё/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/ї/g, 'и')
    .replace(/і/g, 'и')
    .replace(/є/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
