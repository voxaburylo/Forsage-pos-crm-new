/**
 * 21.11.2026 (план «порядок в аналітиці», затверджено власником): звіти зібрано в 6 груп за питанням,
 * на яке вони відповідають. Адреси сторінок не змінено — група лише веде на наявні звіти/вкладки.
 * ABC-аналіз і «Прибутковість працівників» раніше відкривались лише за адресою — тепер у меню.
 */
export type AnalyticsLink = { label: string; to: string; roles: string[] }
export type AnalyticsGroup = { id: string; label: string; links: AnalyticsLink[] }

const OFFICE = ['owner', 'admin', 'manager']
const ADMIN = ['owner', 'admin']
const REPORT = ['owner', 'admin', 'manager', 'cashier']

export const ANALYTICS_GROUPS: AnalyticsGroup[] = [
  { id: 'overview', label: 'Огляд', links: [
    { label: 'Статистика', to: '/analytics/statistics', roles: OFFICE },
  ] },
  { id: 'sales', label: 'Продажі', links: [
    { label: 'Підсумки', to: '/analytics/sales?tab=today', roles: ADMIN },
    { label: 'Продані товари', to: '/analytics/sales?tab=sold', roles: REPORT },
    { label: 'P&L', to: '/analytics/sales?tab=profit', roles: ADMIN },
  ] },
  { id: 'products', label: 'Товари', links: [
    // Два різні показники (не дубль): прогноз за швидкістю продажів (сервер) і залишок нижче мінімуму картки (каса).
    { label: 'Закінчуються (за продажами)', to: '/analytics/control?tab=running', roles: OFFICE },
    { label: 'Нижче мінімуму', to: '/analytics/sales?tab=lowstock', roles: ADMIN },
    { label: 'Перерахунок', to: '/analytics/recount', roles: OFFICE },
    { label: 'Залежані', to: '/analytics/control?tab=stale', roles: OFFICE },
    { label: 'Нижче закупки', to: '/analytics/control?tab=below', roles: OFFICE },
    { label: 'Низька націнка', to: '/analytics/control?tab=low', roles: OFFICE },
    { label: 'ABC-аналіз', to: '/abc', roles: ADMIN },
  ] },
  { id: 'customers', label: 'Клієнти', links: [
    { label: 'Боржники', to: '/analytics/sales?tab=debtors', roles: ADMIN },
  ] },
  { id: 'staff', label: 'Працівники', links: [
    { label: 'По працівниках', to: '/analytics/control?tab=staff', roles: OFFICE },
    { label: 'Шиномонтаж', to: '/analytics/sales?tab=tire', roles: [...ADMIN, 'cashier'] },
    { label: 'Зарплата та виплати', to: '/analytics/payroll', roles: ADMIN },
    { label: 'Прибутковість', to: '/staff-analytics', roles: ADMIN },
  ] },
  { id: 'control', label: 'Контроль', links: [
    { label: 'Порівняння періодів', to: '/analytics/control?tab=compare', roles: OFFICE },
    { label: 'Списання', to: '/analytics/sales?tab=writeoffs', roles: ADMIN },
  ] },
]

const pathOf = (to: string) => to.split('?')[0]
const paramsOf = (to: string) => new URLSearchParams(to.split('?')[1] ?? '')

export function isAnalyticsPath(pathname: string): boolean {
  return ANALYTICS_GROUPS.some(group => group.links.some(link => pathOf(link.to) === pathname))
}

export function visibleAnalyticsGroups(role: string): AnalyticsGroup[] {
  return ANALYTICS_GROUPS
    .map(group => ({ ...group, links: group.links.filter(link => link.roles.includes(role)) }))
    .filter(group => group.links.length > 0)
}

/** Активне посилання: шлях і всі параметри збігаються; інакше — перше посилання з тим самим шляхом. */
export function activeAnalyticsLink(groups: AnalyticsGroup[], pathname: string, search: string): AnalyticsLink | null {
  const current = new URLSearchParams(search)
  const links = groups.flatMap(group => group.links)
  const exact = links.find(link => pathOf(link.to) === pathname
    && [...paramsOf(link.to).entries()].every(([key, value]) => current.get(key) === value))
  return exact ?? links.find(link => pathOf(link.to) === pathname) ?? null
}

/** Вкладки звіту, що належать до тієї ж групи, що й відкрита (щоб усередині звіту не дублювати меню). */
export function reportTabsInGroup(pathname: string, tab: string | null): string[] | null {
  if (!tab) return null
  const group = ANALYTICS_GROUPS.find(item => item.links.some(link => pathOf(link.to) === pathname && paramsOf(link.to).get('tab') === tab))
  if (!group) return null
  return group.links.filter(link => pathOf(link.to) === pathname).map(link => paramsOf(link.to).get('tab') ?? '').filter(Boolean)
}
