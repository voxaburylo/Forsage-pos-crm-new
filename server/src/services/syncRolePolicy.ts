import { isSyncOperationAllowed as isSyncOperationAllowedByCatalog } from '@crm-forsage/shared'

const STAFF_DIRECTORY_ROLES = new Set(['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker'])
const SUPPLY_ROLES = new Set(['owner', 'admin', 'manager', 'cashier', 'storekeeper'])
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

/**
 * Права на надсилання операцій живуть у спільному каталозі
 * (`shared/src/syncOperations.ts`) разом із тим, що кожна операція тягне за
 * собою по зовнішньому ключу. Тримати їх окремо від залежностей уже двічі
 * коштувало магазину даних: дозволили товар без бренда, потім накладну без
 * постачальника. Тест каталогу не дає забути втретє.
 */
export function isSyncOperationAllowed(role: string, operationType: string): boolean {
  return isSyncOperationAllowedByCatalog(role, operationType)
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
    ...(user.role === 'tire_worker' ? { base_rate: user.base_rate, rate_period: user.rate_period } : {}),
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
