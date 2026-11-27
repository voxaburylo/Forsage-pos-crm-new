export type DesktopRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'storekeeper' | 'sto_viewer' | 'tire_worker'

const ALL_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker']
const POS_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier']
const ORDER_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']
const STOCK_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'storekeeper']
const RECEIVING_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']
const INVENTORY_COUNTER_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer']
const OWNER_ROLES: readonly DesktopRole[] = ['owner', 'admin']
const CASHIER_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'cashier']
// 21.11.2026 (рішення власника): менеджер продає лише тоді, коли власник увімкнув йому
// «Може продавати» в «Команда та ЗП». Роль тут пускає менеджера, а сам дозвіл перевіряє
// головний ПК (main.ts, managerSaleAccess) — і для своєї каси, і для команд з ПК менеджера.
const TILL_ROLES: readonly DesktopRole[] = ['owner', 'admin', 'manager', 'cashier']
const MANAGER_SALE_EXACT = new Set<string>([
  ...['checkout', 'create-return', 'refund-core-deposit', 'open-shift', 'close-shift', 'create-cash-operation',
    'pay-debt', 'add-customer-deposit', 'payout-customer-deposit'].map(name => `desktop:pos:${name}`),
  'desktop:orders:add-payment', 'desktop:orders:complete',
])
/** 22.11.2026: із дозволом «Може приймати задаток» менеджеру досить цих дій — своя зміна й оплата замовлення. */
const MANAGER_DEPOSIT_EXACT = new Set<string>(['desktop:pos:open-shift', 'desktop:pos:close-shift', 'desktop:orders:add-payment'])
export function isManagerDepositChannel(channel: string): boolean {
  return MANAGER_DEPOSIT_EXACT.has(channel)
}
/** Дії каси, на які менеджеру потрібен окремий дозвіл власника. */
export function isManagerSaleChannel(channel: string): boolean {
  return MANAGER_SALE_EXACT.has(channel) || (channel.startsWith('desktop:fiscal:') && !['desktop:fiscal:get-config', 'desktop:fiscal:status'].includes(channel))
}

export const PUBLIC_DESKTOP_CHANNELS = new Set([
  'desktop:auth:login',
  'desktop:auth:login-password',
  // Етап 9: імена тих, хто сьогодні вже входив паролем на цьому ПК, і вхід за їхнім PIN.
  'desktop:auth:pin-roster',
  'desktop:auth:login-pin',
  'desktop:auth:login-online',
  'desktop:auth:logout',
  'desktop:auth:remembered-status',
  'desktop:auth:restore',
  // 22.11.2026: стан зв'язку головного ПК і сигнал «на сервері є робота» — потрібні й на екрані входу.
  'desktop:link:status',
  'desktop:link:wake',
  // 23.11.2026: номер збірки на екрані входу — лише збірка й режим ПК, жодних даних магазину.
  'desktop:get-runtime-info-build',
  'desktop:lan:first-run-status',
  'desktop:lan:discover',
  'desktop:lan:pair',
])

const EXACT_RULES = new Map<string, readonly DesktopRole[]>([
  ['desktop:warehouse:writeoffs-summary', ['owner', 'admin', 'manager']],
  // 27.11.2026: касир зі «Списує товар» (перемикач перевіряє main.ts) — створити списання й бачити свої акти.
  ['desktop:warehouse:create-writeoff', ['owner', 'admin', 'manager', 'storekeeper', 'cashier']],
  ['desktop:warehouse:list-writeoffs', ['owner', 'admin', 'manager', 'storekeeper', 'cashier']],
  ['desktop:warehouse:get-writeoff', ['owner', 'admin', 'manager', 'storekeeper', 'cashier']],
  ['desktop:pos:sales-period-report', ['owner', 'admin', 'manager']],
  ['desktop:auth:save-server-session', ALL_ROLES],
  ['desktop:auth:restore-server-session', ALL_ROLES],
  ['desktop:staff:restore-user', OWNER_ROLES],
  ['desktop:staff:save-settings', OWNER_ROLES],
  ['desktop:staff:list-users', OWNER_ROLES],
  ['desktop:orders:accept-offline', ['owner', 'admin', 'manager']],
  ['desktop:orders:discard-offline', ['owner', 'admin', 'manager']],
  ['desktop:orders:retry-offline', ['owner', 'admin', 'manager']],
  ['desktop:catalog:agent-scan', OWNER_ROLES],
  ['desktop:pos:list-open-shifts', ['owner', 'admin', 'manager']],
  // Команда з вебу: хто б не сидів за касою, право дає власник/адмін, який її поставив (перевірка в main.ts).
  ['desktop:pos:remote-shifts', POS_ROLES],
  ['desktop:pos:remote-close-shift', POS_ROLES],
  ...['scan', 'preview', 'apply', 'apply-sku', 'tidy-plan', 'tidy-apply'].map((mode): [string, readonly DesktopRole[]] => [`desktop:catalog:cleanup-${mode}`, OWNER_ROLES]),
  ['desktop:catalog:agent-apply', OWNER_ROLES],
  ['desktop:catalog:negative-stock', ['owner', 'admin', 'manager', 'storekeeper']],
  ['desktop:catalog:agent-fingerprints', OWNER_ROLES],
  ['desktop:warehouse:list-consumptions', ['owner', 'admin', 'manager']],
  ['desktop:warehouse:create-consumption', ['owner', 'admin', 'manager']],
  ['desktop:warehouse:resolve-consumption', ['owner', 'admin', 'manager']],
  ['desktop:pos:delete-customer', OWNER_ROLES],
  ['desktop:orders:add-payment', TILL_ROLES],
  ['desktop:orders:complete', TILL_ROLES],
  // 25.11.2026 (рішення власника): замовлення видає менеджер, гроші приймає каса; неоплачене — борг клієнта.
  // Грошей ця дія не бере, тому менеджеру не потрібен дозвіл «Може продавати».
  ['desktop:orders:hand-over', TILL_ROLES],
  ...['checkout', 'create-return', 'refund-core-deposit', 'open-shift', 'close-shift', 'create-cash-operation',
    'pay-debt', 'add-customer-deposit', 'payout-customer-deposit'].map((name): [string, readonly DesktopRole[]] => [`desktop:pos:${name}`, TILL_ROLES]),

  ['desktop:backup-now', OWNER_ROLES],
  ...['pending', 'status', 'upload', 'confirmed', 'failed'].map((name): [string, readonly DesktopRole[]] => [`desktop:backup:${name}`, CASHIER_ROLES]),
  // Відкат бази затирає роботу, зроблену після копії — тільки власник.
  ['desktop:backup:list', OWNER_ROLES],
  ['desktop:backup:restore', OWNER_ROLES],
  // Аварійне відновлення: скачати найсвіжішу копію з хмари у папку копій цього ПК (заміна бази — окремий крок).
  ['desktop:backup:fetch-cloud', OWNER_ROLES],
  // Копії на флешку: вибір носія, запис і повернення копії з носія — тільки власник.
  ['desktop:backup:external-status', OWNER_ROLES],
  ['desktop:backup:external-choose', OWNER_ROLES],
  ['desktop:backup:external-clear', OWNER_ROLES],
  ['desktop:backup:external-run', OWNER_ROLES],
  ['desktop:backup:external-import', OWNER_ROLES],
  // Журнал проблем читає той, хто стоїть за касою: саме він бачить збій першим
  // і має що сказати. Закривати й вивантажувати список — справа власника.
  ['desktop:problems:list', RECEIVING_ROLES],
  ['desktop:problems:summary', RECEIVING_ROLES],
  ['desktop:problems:resolve', OWNER_ROLES],
  ['desktop:problems:resolve-all', OWNER_ROLES],
  ['desktop:problems:export', OWNER_ROLES],
  ['desktop:lan:get-status', OWNER_ROLES],
  ['desktop:lan:update', OWNER_ROLES],
  ['desktop:lan:test', OWNER_ROLES],
  ['desktop:lan:diagnose', OWNER_ROLES],
  ['desktop:lan:allow-firewall', OWNER_ROLES],
  // 27.11.2026: код для телефонів через Wi-Fi — видає й змінює власник/адміністратор.
  ['desktop:lan:phone-access', OWNER_ROLES],
  ['desktop:lan:phone-access-set', OWNER_ROLES],
  // Телефон сам отримує доступ через Wi-Fi для того, хто вже увійшов (ті самі ролі, що працюють через веб).
  ['desktop:phone:wifi-pairing', TILL_ROLES],
  ['desktop:bootstrap:import-snapshot', OWNER_ROLES],
  ['desktop:catalog:update-settings', OWNER_ROLES],
  ['desktop:catalog:create-category', RECEIVING_ROLES],
  ['desktop:catalog:update-category', OWNER_ROLES],
  ['desktop:catalog:delete-category', OWNER_ROLES],
  ['desktop:catalog:update-brand', OWNER_ROLES],
  ['desktop:catalog:delete-brand', OWNER_ROLES],
  ['desktop:staff:verify-pin', ALL_ROLES],
  ['desktop:staff:tire-service-report', POS_ROLES],
  // 23.11.2026 (власник): зарплату наприкінці дня видає касир — лише у своїй зміні (перевіряє staffRepository).
  ['desktop:staff:payout-list', POS_ROLES],
  // 24.11.2026: свої права питає кожен, хто увійшов; чужі й зміну — лише власник (загальне правило desktop:staff:).
  ['desktop:staff:my-rights', ALL_ROLES],
  ['desktop:maintenance:outbox-preview', OWNER_ROLES],
  ['desktop:maintenance:outbox-compact', OWNER_ROLES],
  ['desktop:staff:daily-payout', POS_ROLES],
  ['desktop:staff:tire-cash-handover', POS_ROLES],
  ['desktop:inventory:create-session', RECEIVING_ROLES],
  ['desktop:inventory:create-product', RECEIVING_ROLES],
  ['desktop:inventory:start-session', RECEIVING_ROLES],
  ['desktop:inventory:delete-session', RECEIVING_ROLES],
  ['desktop:inventory:apply-price', RECEIVING_ROLES],
  ['desktop:inventory:update-products', RECEIVING_ROLES],
  ['desktop:inventory:complete', RECEIVING_ROLES],
  ['desktop:catalog:save-product', RECEIVING_ROLES],
  ['desktop:catalog:change-cross-numbers', RECEIVING_ROLES],
  // Фото — частина картки, з тими самими правами, а не адміністрування складу.
  ['desktop:catalog:save-photo', RECEIVING_ROLES],
  ['desktop:catalog:delete-photo', RECEIVING_ROLES],
  ['desktop:catalog:apply-batch', RECEIVING_ROLES],
  ['desktop:catalog:analytics', OWNER_ROLES],
  ['desktop:catalog:generate-barcode', RECEIVING_ROLES],
  ['desktop:supply:list-suppliers', RECEIVING_ROLES],
  ['desktop:supply:get-supplier', RECEIVING_ROLES],
  ['desktop:supply:save-supplier', RECEIVING_ROLES],
  ['desktop:supply:list-invoices', RECEIVING_ROLES],
  ['desktop:supply:get-invoice', RECEIVING_ROLES],
  ['desktop:supply:create-invoice', RECEIVING_ROLES],
  ['desktop:supply:commit-receiving', RECEIVING_ROLES],
  ['desktop:supply:create-invoice-from-ai', RECEIVING_ROLES],
  ['desktop:supply:preview-invoice-from-ai', RECEIVING_ROLES],
  ['desktop:supply:prewarm-invoice-check', RECEIVING_ROLES],
  ['desktop:supply:update-invoice', RECEIVING_ROLES],
  ['desktop:supply:post-invoice', RECEIVING_ROLES],
  ['desktop:supply:pay-invoice', RECEIVING_ROLES],
  ['desktop:supply:delete-invoice', RECEIVING_ROLES],
  ['desktop:pos:reconcile', OWNER_ROLES],
  ['desktop:pos:payout-customer-deposit', TILL_ROLES],
  // 23.11.2026 (план B2): пачки карток для друкарні видає власник чи адміністратор; «вільну картку» впізнає каса.
  ['desktop:pos:card-batches', OWNER_ROLES],
  ['desktop:pos:card-batch-codes', OWNER_ROLES],
  ['desktop:pos:card-batch-create', OWNER_ROLES],
  ['desktop:fiscal:set-config', OWNER_ROLES],
  ['desktop:fiscal:get-config', POS_ROLES],
  ['desktop:fiscal:status', POS_ROLES],
  ['desktop:fiscal:register-com', OWNER_ROLES],
])

const PREFIX_RULES: Array<[string, readonly DesktopRole[]]> = [
  // 22.11.2026: ключ зв'язку головного ПК приносить власник чи адміністратор; «команди забрано» — будь-хто на зміні.
  ['desktop:link:commands-taken', ['owner', 'admin', 'manager', 'cashier']],
  // 23.11.2026: «передай зміни на сервер зараз» — будь-хто на касі; сама передача йде ключем ПК.
  ['desktop:link:push-outbox', ['owner', 'admin', 'manager', 'cashier', 'storekeeper']],
  // 24.11.2026: помічник ключем ПК — тим самим ролям, яким сервер дозволяє помічника.
  ['desktop:link:assistant', ['owner', 'admin', 'manager', 'cashier']],
  ['desktop:link:', OWNER_ROLES],
  // 22.11.2026: каса виконує запит вебу від імені того працівника, що в вебі (його права перевіряються окремо).
  ['desktop:web-rpc:', ['owner', 'admin', 'manager', 'cashier']],
  // 22.11.2026: зміну PIN/пароля з вебу застосовує каса під будь-ким; право перевіряється за автором зміни.
  ['desktop:staff:apply-remote-secret', ['owner', 'admin', 'manager', 'cashier']],
  ['desktop:purchases:', ['owner', 'admin', 'manager']],
  ['desktop:staff:', OWNER_ROLES],
  ['desktop:supplier-catalog:', STOCK_ROLES],
  ['desktop:supply:', STOCK_ROLES],
  ['desktop:warehouse:', STOCK_ROLES],
  ['desktop:inventory:', INVENTORY_COUNTER_ROLES],
  ['desktop:orders:', ORDER_ROLES],
  ['desktop:pos:', POS_ROLES],
  ['desktop:fiscal:', TILL_ROLES],
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

/**
 * 25.11.2026 (ПК менеджера: «не підтягує авто клієнта, не дає додати нове»). «Магазин не вказано» (undefined) у
 * мережі (JSON) стає null, а значення за замовчуванням у дії каси спрацьовує лише для undefined — головний ПК шукав
 * клієнта магазину null і відмовляв. Для вебу це виправлено 23.11; тепер те саме для кожної команди з мережі.
 */
export function normalizeRemoteTenantArguments(channel: string, args: readonly unknown[]): unknown[] {
  const list = Array.isArray(args) ? [...args] : []
  for (const position of desktopTenantArgumentPositions(channel)) if (list[position] === null) list[position] = undefined
  return list
}

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
