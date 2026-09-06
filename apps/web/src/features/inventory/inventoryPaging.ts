export const INVENTORY_PAGE_SIZE = 150
export function inventoryPage(total: number, requested: number) {
  const pages = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE))
  const page = Math.max(0, Math.min(Math.trunc(requested), pages - 1))
  return { page, pages, start: page * INVENTORY_PAGE_SIZE, end: Math.min(total, (page + 1) * INVENTORY_PAGE_SIZE) }
}
