/**
 * Крос-номери за брендами (23.11.2026, слово власника): як у постачальників —
 * «Hyundai: 26300-35503, 26300-35504» рядком, потім «Kia: …», «MANN: …»; бренд один раз, номери через кому.
 * Так їх можна і вставити в картку, і побачити в ній.
 */
export interface CrossPasteEntry { number: string; brand: string | null }

const brandKey = (brand: string) => brand.toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Розбирає вставлений текст. Рядок «Бренд: номер, номер» дає номерам бренд; рядок без бренду — просто номери.
 * Бренд — до двокрапки, починається з літери й короткий: так «12:30» чи довге речення брендом не стануть.
 */
export function parseCrossPaste(text: string): CrossPasteEntry[] {
  const seen = new Set<string>()
  const result: CrossPasteEntry[] = []
  for (const line of String(text ?? '').split(/[\r\n;]+/)) {
    const match = /^\s*(\p{L}[^:]{0,39}?)\s*:\s*(.+)$/u.exec(line)
    const brand = match ? match[1].trim() : null
    for (const raw of (match ? match[2] : line).split(/[,\t]+/)) {
      const number = raw.trim()
      const key = number.toLocaleUpperCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, '')
      if (!number || !key || seen.has(key)) continue
      seen.add(key)
      result.push({ number, brand })
    }
  }
  return result
}

/** Групи для показу: бренди в порядку появи, номери без бренду — останньою групою «Інші». */
export function groupCrossNumbers<T extends { number: string; brand?: string | null }>(numbers: readonly T[]): Array<{ brand: string; items: T[] }> {
  const groups = new Map<string, { brand: string; items: T[] }>()
  for (const entry of numbers) {
    const brand = typeof entry.brand === 'string' ? entry.brand.trim() : ''
    const key = brand ? brandKey(brand) : ''
    const group = groups.get(key) ?? { brand, items: [] }
    group.items.push(entry)
    groups.set(key, group)
  }
  const unnamed = groups.get('')
  return [...[...groups.entries()].filter(([key]) => key).map(([, group]) => group), ...(unnamed ? [unnamed] : [])]
}

/** Текст для копіювання й передачі клієнту чи постачальнику: «Hyundai: a, b; Kia: c». */
export function crossNumbersText(numbers: ReadonlyArray<{ number: string; brand?: string | null }>): string {
  const groups = groupCrossNumbers(numbers)
  const named = groups.some(group => group.brand)
  return groups.map(group => (group.brand ? group.brand + ': ' : named ? 'Інші: ' : '') + group.items.map(item => item.number).join(', ')).join('; ')
}
