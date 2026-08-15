const STAFF_DIRECTORY_ROLES = new Set(['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker'])
const SUPPLY_ROLES = new Set(['owner', 'admin', 'manager', 'storekeeper'])
const PRIVILEGED_SETTINGS_ROLES = new Set(['owner', 'admin'])
const CASHDESK_SETTINGS_KEYS = new Set([
  'shop_name',
  'shop_address',
  'phone',
  'currency',
  'max_discount_pct',
  'allow_negative_qty',
  'return_days',
  'default_debt_limit_kopecks',
  'label_settings',
  'pos_quick_items',
  'price_rounding_enabled',
  'price_rounding_step',
  'price_rounding_dir',
  'quick_percents',
  'employee_discount_pct',
  'auto_print_receipt',
  'receipt_width_mm',
])
const COMMERCIAL_FIELDS = new Set(['buy_price', 'purchase_price', 'cost_price'])

const MANAGER_SYNC_OPERATIONS = new Set([
  'shift.opened', 'shift.closed', 'sale.completed', 'sale.suspended',
  'sale.suspended_resumed', 'sale.suspended_deleted', 'product.upsert',
  'category.upsert', 'brand.upsert', 'order.payment_added', 'order.completed',
  'customer.debt_paid', 'customer.deposit_changed', 'customer.bonus_adjusted', 'supplier_invoice.created',
  'supplier_invoice.updated', 'supplier_invoice.posted', 'supplier_invoice.payment_added',
  'customer.created', 'customer.updated', 'customer_vehicle.created',
  'customer_vehicle.updated', 'customer_vehicle.deleted', 'supplier.created',
  'supplier.updated', 'order.created', 'order.updated', 'order.status_updated',
  'order.item_status_updated', 'order.items_arrived', 'order.canceled',
  'cash_operation.created', 'reserve.created', 'reserve.released',
  'warehouse_movement.created', 'writeoff.created', 'return.created',
])
const CASHIER_SYNC_OPERATIONS = new Set([
  'shift.opened', 'shift.closed', 'sale.completed', 'sale.suspended',
  'sale.suspended_resumed', 'sale.suspended_deleted', 'customer.created', 'customer.updated',
  'customer_vehicle.created', 'customer_vehicle.updated', 'customer_vehicle.deleted',
  'customer.debt_paid', 'customer.deposit_changed', 'return.created',
  'order.payment_added', 'order.completed', 'cash_operation.created',
])
const STOREKEEPER_SYNC_OPERATIONS = new Set([
  'product.upsert', 'category.upsert', 'brand.upsert', 'supplier_invoice.created',
  'supplier_invoice.posted', 'order.item_status_updated', 'order.items_arrived',
  'reserve.created', 'reserve.released', 'warehouse_movement.created', 'writeoff.created',
  'inventory.created', 'inventory.started', 'inventory.deleted',
])

export function isSyncOperationAllowed(role: string, operationType: string): boolean {
  if (role === 'owner' || role === 'admin') return true
  const allowed = role === 'manager'
    ? MANAGER_SYNC_OPERATIONS
    : role === 'cashier'
      ? CASHIER_SYNC_OPERATIONS
      : role === 'storekeeper'
        ? STOREKEEPER_SYNC_OPERATIONS
        : null
  return allowed?.has(operationType) === true
}
export function canPullStaffDirectory(role: string): boolean {
  return STAFF_DIRECTORY_ROLES.has(role)
}

export function buildStaffSyncPayload(staff: Array<Record<string, any>>, role: string) {
  const canPullPayroll = role === 'owner' || role === 'admin'
  const staffDirectory = canPullPayroll ? [] : staff.map((user) => ({
    id: user.id,
    phone: user.phone,
    full_name: user.full_name,
    role: user.role,
    is_active: user.is_active,
    created_at: user.created_at,
    updated_at: user.updated_at,
  }))
  return {
    staff: canPullPayroll ? staff : [],
    staff_directory: staffDirectory,
    staff_snapshot_included: canPullPayroll,
    staff_directory_snapshot_included: canPullStaffDirectory(role) && !canPullPayroll,
  }
}

export function canPullSupplyData(role: string): boolean {
  return SUPPLY_ROLES.has(role)
}

export function sanitizeShopSettingsForRole(
  row: Record<string, any> | null | undefined,
  role: string,
): Record<string, any> | null {
  if (!row) return null
  const { ai_api_key_encrypted: _omit, ...withoutAiSecret } = row
  if (PRIVILEGED_SETTINGS_ROLES.has(role)) return withoutAiSecret
  return Object.fromEntries(
    Object.entries(withoutAiSecret).filter(([key]) => CASHDESK_SETTINGS_KEYS.has(key)),
  )
}

export function sanitizeCommercialFieldsForRole<T>(value: T, role: string): T {
  if (role !== 'cashier') return value

  const visit = (current: any): any => {
    if (Array.isArray(current)) return current.map(visit)
    if (!current || typeof current !== 'object') return current
    return Object.fromEntries(
      Object.entries(current)
        .filter(([key]) => !COMMERCIAL_FIELDS.has(key))
        .map(([key, nested]) => [key, visit(nested)]),
    )
  }

  return visit(value) as T
}