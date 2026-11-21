/**
 * 21.11.2026 (рішення власника: продаж у мінус дозволено). Каса попереджає, але не зупиняє продаж:
 * товар потрапить у «Аналітика → Перерахунок», де його перерахують на полиці.
 */
export function stockWarningText(name: string, available: number, unit: string | null | undefined): string {
  const have = available <= 0 ? 'за програмою немає' : `за програмою ${available} ${unit ?? ''}`.trim()
  return `«${name}»: ${have}. Продаж у мінус — товар потрапить у «Перерахунок».`
}
