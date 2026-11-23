/**
 * Крос-номери з чату помічника (add_cross_numbers_bulk) — у базу каси тим самим записом, що й
 * ручне додавання в картці («Кроси»). Джерело номера зберігається («ШІ: mann-filter.com»).
 * Товар, якого немає в касі, пропускається з причиною; уже наявні номери не дублюються.
 */
export interface ChatCrossItem { product_id?: unknown; numbers?: Array<{ number?: unknown; brand?: unknown; source?: unknown }> }
export interface ChatCrossBridge {
  changeCrossNumbers: (productId: string, change: { add?: Array<string | { number: string; brand?: string | null }>; source?: string }) => Promise<Array<{ id: string; number: string; source: string }>>
}

export async function applyChatCrossNumbers(items: readonly ChatCrossItem[], bridge: ChatCrossBridge): Promise<{ products: number; numbers: number; skipped: Array<{ item: string; error: string }> }> {
  const result = { products: 0, numbers: 0, skipped: [] as Array<{ item: string; error: string }> }
  for (const item of items) {
    const productId = typeof item?.product_id === 'string' ? item.product_id : ''
    const numbers = (Array.isArray(item?.numbers) ? item.numbers : [])
      .map(entry => ({ number: typeof entry?.number === 'string' ? entry.number.trim() : '',
        brand: typeof entry?.brand === 'string' && entry.brand.trim() ? entry.brand.trim().slice(0, 100) : null }))
      .filter(entry => entry.number && entry.number.length <= 120)
      // Бренд номера зберігається в картці («Hyundai: a, b; Kia: c»); без бренду — як і раніше, просто номер.
      .map(entry => entry.brand ? entry : entry.number)
    if (!productId || !numbers.length) { result.skipped.push({ item: productId || '—', error: 'Немає номерів для додавання' }); continue }
    const sources = [...new Set((item.numbers ?? []).map(entry => typeof entry?.source === 'string' ? entry.source : '').filter(Boolean))]
    try {
      const before = numbers.length
      await bridge.changeCrossNumbers(productId, { add: numbers, source: ('ШІ-помічник: ' + (sources.join(', ') || 'джерело в чаті')).slice(0, 200) })
      result.products += 1
      result.numbers += before
    } catch (error) {
      result.skipped.push({ item: productId, error: error instanceof Error ? error.message : 'Не вдалося додати номери' })
    }
  }
  return result
}
