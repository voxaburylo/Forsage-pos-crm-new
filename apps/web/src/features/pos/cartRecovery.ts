// A stored snapshot of a live receipt is not another receipt to restore.
// Compare operation IDs, never products: two real checks may contain the same item.
export function missingSavedTabs<T extends { idempotencyKey: string }>(
  saved: readonly T[], live: readonly { idempotencyKey: string }[],
): T[] {
  const seen = new Set(live.map(t => t.idempotencyKey))
  return saved.filter(tab => {
    if (seen.has(tab.idempotencyKey)) return false
    seen.add(tab.idempotencyKey)
    return true
  })
}
