// UX preflight only: the authenticated desktop IPC remains the authoritative guard.
export function canApplyAiWrite(tool: string, role: unknown, desktop: boolean): boolean {
  // Зміни карток із чату пишуться в базу каси захищеним шляхом «Помічника каталогу» — лише власник/адміністратор.
  if (['update_products_bulk', 'create_categories_bulk', 'rename_categories_bulk', 'merge_products_bulk', 'add_cross_numbers_bulk'].includes(tool)) return desktop && typeof role === 'string' && ['owner', 'admin'].includes(role)
  return desktop && ['create_order', 'create_supply_invoice_bulk'].includes(tool)
    && typeof role === 'string' && ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role)
}
const CATALOG_TOOLS = ['update_products_bulk', 'create_categories_bulk', 'rename_categories_bulk', 'merge_products_bulk', 'add_cross_numbers_bulk']
/**
 * Чому пропозицію не можна застосувати — людськими словами й із тим, що робити (24.11.2026: власник побачив
 * «Ця дія недоступна для запису» без кнопок і не зрозумів, що сталося). null — застосувати можна.
 */
export function aiWriteBlockReason(tool: string, role: unknown, desktop: boolean): string | null {
  if (canApplyAiWrite(tool, role, desktop)) return null
  const known = CATALOG_TOOLS.includes(tool) || ['create_order', 'create_supply_invoice_bulk'].includes(tool)
  if (!known) return 'Цю пропозицію помічник лише показує: записати її з чату не можна. Внесіть зміни у відповідному розділі програми.'
  if (!desktop) return 'Немає звʼязку з головним ПК, тому записати нікуди: зміни вносить програма на головному ПК. Увімкніть її (достатньо, щоб вона працювала у фоні) — кнопка «Застосувати» зʼявиться тут сама, пропозиція не зникне.'
  return CATALOG_TOOLS.includes(tool)
    ? 'Змінювати товари й категорії з чату може лише власник або адміністратор. Увійдіть під своїм обліковим записом — пропозиція збережеться.'
    : 'Для вашого облікового запису ця дія недоступна.'
}
export function assertAiWriteAllowed(tool: string, role: unknown, desktop: boolean): void {
  if (!canApplyAiWrite(tool, role, desktop)) throw new Error('Ця дія ШІ недоступна для вашого облікового запису або режиму програми. Дані не змінено.')
}
