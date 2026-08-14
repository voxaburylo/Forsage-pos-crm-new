export type DesktopRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'storekeeper' | 'sto_viewer' | 'tire_worker'

const ALL_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker']
const POS_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier']
const ORDER_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']
const STOCK_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'storekeeper']
const RECEIVING_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']
const INVENTORY_COUNTER_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer']
const OWNER_ROLES: readonly DesktopRole[] = ['owner', 'admin']

export const PUBLIC_DESKTOP_CHANNELS = new Set([
  'desktop:auth:login',
  'desktop:auth:login-online',
  'desktop:auth:logout',
])

const EXACT_RULES = new Map<string, readonly DesktopRole[]>([
  ['desktop:backup-now', OWNER_ROLES],
  ['desktop:lan:get-status', OWNER_ROLES],
  ['desktop:lan:update', OWNER_ROLES],
  ['desktop:lan:test', OWNER_ROLES],
  ['desktop:bootstrap:import-snapshot', OWNER_ROLES],
  ['desktop:catalog:update-settings', OWNER_ROLES],
  ['desktop:catalog:update-category', OWNER_ROLES],
  ['desktop:catalog:delete-category', OWNER_ROLES],
  ['desktop:catalog:update-brand', OWNER_ROLES],
  ['desktop:catalog:delete-brand', OWNER_ROLES],
  ['desktop:staff:verify-pin', ALL_ROLES],
  ['desktop:inventory:create-session', RECEIVING_ROLES],
  ['desktop:inventory:start-session', RECEIVING_ROLES],
  ['desktop:inventory:delete-session', RECEIVING_ROLES],
  ['desktop:inventory:apply-price', RECEIVING_ROLES],
  ['desktop:inventory:complete', RECEIVING_ROLES],
  ['desktop:catalog:save-product', RECEIVING_ROLES],
  ['desktop:catalog:generate-barcode', RECEIVING_ROLES],
  ['desktop:supply:list-suppliers', RECEIVING_ROLES],
  ['desktop:supply:get-supplier', RECEIVING_ROLES],
  ['desktop:supply:list-invoices', RECEIVING_ROLES],
  ['desktop:supply:get-invoice', RECEIVING_ROLES],
  ['desktop:supply:create-invoice', RECEIVING_ROLES],
  ['desktop:supply:create-invoice-from-ai', RECEIVING_ROLES],
  ['desktop:supply:update-invoice', RECEIVING_ROLES],
  ['desktop:supply:post-invoice', RECEIVING_ROLES],
  ['desktop:supply:pay-invoice', RECEIVING_ROLES],
  ['desktop:supply:delete-invoice', RECEIVING_ROLES],
  ['desktop:pos:reconcile', OWNER_ROLES],
  ['desktop:pos:payout-customer-deposit', ['owner', 'admin', 'cashier']],
  ['desktop:fiscal:set-config', OWNER_ROLES],
  ['desktop:fiscal:register-com', OWNER_ROLES],
])

const PREFIX_RULES: Array<[string, readonly DesktopRole[]]> = [
  ['desktop:staff:', OWNER_ROLES],
  ['desktop:supplier-catalog:', STOCK_ROLES],
  ['desktop:supply:', STOCK_ROLES],
  ['desktop:warehouse:', STOCK_ROLES],
  ['desktop:inventory:', INVENTORY_COUNTER_ROLES],
  ['desktop:orders:', ORDER_ROLES],
  ['desktop:pos:', POS_ROLES],
  ['desktop:fiscal:', POS_ROLES],
  ['desktop:catalog:save-', STOCK_ROLES],
  ['desktop:catalog:delete-', STOCK_ROLES],
  ['desktop:catalog:upsert-', STOCK_ROLES],
  ['desktop:catalog:create-', STOCK_ROLES],
  ['desktop:catalog:', ALL_ROLES],
  ['desktop:sync:', ALL_ROLES],
  ['desktop:print:', ALL_ROLES],
  ['desktop:get-runtime-info', ALL_ROLES],
]

const TENANT_ARGUMENT_POSITIONS = new Map<string, readonly number[]>([
  ['desktop:supplier-catalog:list-imports', [0]],
  ['desktop:supplier-catalog:get-import', [1]],
  ['desktop:supplier-catalog:update', [2]],
  ['desktop:supplier-catalog:delete', [1]],
  ['desktop:warehouse:list-reserves', [0]],
  ['desktop:warehouse:release-reserve', [1]],
  ['desktop:warehouse:get-writeoff', [1]],
  ['desktop:inventory:delete-session', [1]],
  ['desktop:inventory:remove-item', [2]],
  ['desktop:inventory:labels', [1]],
  ['desktop:orders:delete', [1]],
  ['desktop:orders:update-status', [2]],
  ['desktop:orders:update-item-status', [3]],
  ['desktop:orders:pending-items', [1]],
  ['desktop:orders:bulk-arrival', [1]],
  ['desktop:orders:get', [1]],
  ['desktop:orders:list-payments', [1]],
  ['desktop:supply:get-supplier', [1]],
  ['desktop:supply:delete-supplier', [1]],
  ['desktop:supply:merge-suppliers', [2]],
  ['desktop:supply:get-debts', [0]],
  ['desktop:supply:get-invoice', [1]],
  ['desktop:supply:cancel-invoice', [1]],
  ['desktop:supply:delete-invoice', [1]],
  ['desktop:pos:get-customer', [1]],
  ['desktop:pos:get-customer-sales', [1]],
  ['desktop:pos:delete-customer', [1]],
  ['desktop:pos:list-customer-vehicles', [1]],
  ['desktop:pos:delete-customer-vehicle', [2]],
  ['desktop:pos:get-customer-deposit', [1]],
  ['desktop:pos:list-cash-operations', [1]],
  ['desktop:pos:cash-operation-summary', [1]],
  ['desktop:pos:get-return', [1]],
  ['desktop:pos:get-sale-for-return', [1]],
  ['desktop:pos:get-sale', [1]],
  ['desktop:pos:calculate-prices', [1]],
  ['desktop:pos:list-suspended', [0]],
  ['desktop:pos:resume-sale', [1]],
  ['desktop:pos:confirm-resume-sale', [1]],
  ['desktop:pos:discard-suspended-sale', [1]],
  ['desktop:pos:check-sale-after-payment', [2]],
])

export function desktopTenantArgumentPositions(channel: string): readonly number[] {
  return TENANT_ARGUMENT_POSITIONS.get(channel) ?? []
}
export function isDesktopChannelAllowed(channel: string, role: string): boolean {
  if (PUBLIC_DESKTOP_CHANNELS.has(channel)) return true
  const exact = EXACT_RULES.get(channel)
  if (exact) return exact.includes(role as DesktopRole)
  const prefix = PREFIX_RULES.find(([candidate]) => channel.startsWith(candidate))
  return prefix ? prefix[1].includes(role as DesktopRole) : false
}