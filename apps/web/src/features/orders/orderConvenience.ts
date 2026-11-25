/** A failed read is not evidence that a customer or their history is absent. */
export async function readOrderList<T>(read: () => Promise<{ data: T[] }>, error: string): Promise<{ data: T[]; error?: never } | { error: string; data?: never }> {
  try {
    const result = await read()
    return Array.isArray(result?.data) ? { data: result.data } : { error }
  } catch (cause) {
    // 25.11.2026 (ПК менеджера: «не підтягує авто»): причину відмови показуємо — інакше її не бачить ніхто.
    const reason = cause instanceof Error ? cause.message.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    return { error: reason && !error.includes(reason) ? `${error} Причина: ${reason}` : error }
  }
}

export function orderItemPreview<T extends { name: string; sku?: string | null; is_draft_note?: boolean }>(items: readonly T[], search: string) {
  const positions = items.filter(item => !item.is_draft_note)
  const tokens = search.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean)
  const matches = (item: T) => {
    const text = `${item.name} ${item.sku ?? ''}`.toLocaleLowerCase('uk-UA')
    return tokens.length > 0 && tokens.every(token => text.includes(token))
  }
  const sorted = tokens.length ? [...positions.filter(matches), ...positions.filter(item => !matches(item))] : positions
  const visible = sorted.slice(0, 3)
  return { items: visible, total: positions.length, remaining: positions.length - visible.length }
}
