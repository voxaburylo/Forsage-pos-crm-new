// UX preflight only: the authenticated desktop IPC remains the authoritative guard.
export function canApplyAiWrite(tool: string, role: unknown, desktop: boolean): boolean {
  return desktop && ['create_order', 'create_supply_invoice_bulk'].includes(tool)
    && typeof role === 'string' && ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role)
}
export function assertAiWriteAllowed(tool: string, role: unknown, desktop: boolean): void {
  if (!canApplyAiWrite(tool, role, desktop)) throw new Error('Ця дія ШІ недоступна для вашого облікового запису або режиму програми. Дані не змінено.')
}
