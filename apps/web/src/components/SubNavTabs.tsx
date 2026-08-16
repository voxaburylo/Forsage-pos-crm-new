import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

interface TabItem {
  label: string
  to: string
  roles?: string[]
  serverOnly?: boolean
}

interface SubNavTabsProps {
  tabs: TabItem[]
  currentRole?: string
}

export function SubNavTabs({ tabs, currentRole }: SubNavTabsProps) {
  const location = useLocation()
  const offlineMode = useAuthStore((state) => state.offlineMode)

  const visibleTabs = tabs.filter(
    (tab) => (!tab.serverOnly || !offlineMode) && (!tab.roles || !currentRole || tab.roles.includes(currentRole))
  )

  if (visibleTabs.length <= 1) return null

  // Чи активна якась під-вкладка з query на поточному pathname — тоді базову (без query)
  // вкладку того ж pathname не підсвічуємо, щоб не світилися дві одразу.
  const queryTabActive = visibleTabs.some((t) => {
    if (!t.to.includes('?')) return false
    const [path, search] = t.to.split('?')
    if (location.pathname !== path) return false
    const sp = new URLSearchParams(search)
    const cur = new URLSearchParams(location.search)
    return Array.from(sp.entries()).every(([k, v]) => cur.get(k) === v)
  })

  return (
    <div className="flex border-b border-gray-100 mb-4 -mx-4 px-4 -mt-4 md:-mx-6 md:px-6 md:-mt-6 bg-white shrink-0">
      <div className="flex flex-wrap gap-x-5 gap-y-0">
        {visibleTabs.map((tab) => {
          const isActive = (() => {
            if (tab.to.includes('?')) {
              const [path, search] = tab.to.split('?')
              const searchParams = new URLSearchParams(search)
              const currentParams = new URLSearchParams(location.search)

              const pathMatches = location.pathname === path
              const paramsMatch = Array.from(searchParams.entries()).every(
                ([key, val]) => currentParams.get(key) === val
              )
              return pathMatches && paramsMatch
            }
            // Базова вкладка без query не активна, якщо активна під-вкладка того ж pathname
            if (queryTabActive && location.pathname === tab.to) return false
            if (tab.to === '/customers' || tab.to === '/suppliers' || tab.to === '/products' || tab.to === '/sales' || tab.to === '/inventory' || tab.to === '/reports' || tab.to === '/staff' || tab.to === '/settings') {
              return location.pathname === tab.to
            }
            return location.pathname === tab.to || (tab.to !== '/' && location.pathname.startsWith(tab.to + '/'))
          })()

          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`py-2.5 px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-all duration-200 ${
                isActive
                  ? 'border-[#FFD000] text-gray-900 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-900 hover:border-gray-200'
              }`}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

export const CUSTOMERS_TABS = [
  { to: '/customers', label: 'Клієнти' }
]

export const PRODUCTS_TABS = [
  { to: '/products', label: 'Товари' }
]

export const ORDERS_TABS = [
  { to: '/orders', label: 'Замовлення' }
]

export const FINANCE_TABS = [
  { to: '/sales', label: 'Журнал продажів' },
  { to: '/returns', label: 'Повернення' },
  { to: '/cashflow', label: 'Каса та витрати' }
]

export const SUPPLIERS_TABS = [
  { to: '/suppliers', label: 'Постачальники', roles: ['owner', 'admin', 'manager'] },
  { to: '/suppliers/pos', label: 'Замовлення постачальникам', serverOnly: true },
]

// Поступлення товарів — єдиний дім для приходу (накладні + імпорт), щоб не дублювати
// з керуванням постачальниками.
export const RECEIVING_TABS = [
  { to: '/suppliers/invoices', label: 'Накладні' },
  { to: '/suppliers/import', label: 'Імпорт' },
]

export const INVENTORY_TABS = [
  { to: '/inventory', label: 'Ревізія залишків', roles: ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer'] },
  { to: '/inventory/movements', label: 'Між комірками', roles: ['owner', 'admin', 'storekeeper'] },
  { to: '/inventory/reserves', label: 'Резерви замовлень', roles: ['owner', 'admin', 'manager', 'storekeeper'] },
  { to: '/inventory/writeoffs', label: 'Списання', roles: ['owner', 'admin', 'storekeeper'] },
]

export const ANALYTICS_TABS = [
  { to: '/dashboard', label: 'Дашборд', roles: ['owner', 'admin', 'manager'] },
  { to: '/reports', label: 'Продані товари / звіти', roles: ['owner', 'admin', 'manager', 'cashier'] },
]

export const STAFF_TABS = [
  { to: '/staff', label: 'Команда та ЗП', roles: ['owner', 'admin'] }
]

export const SETTINGS_TABS = [
  { to: '/settings', label: 'Налаштування', roles: ['owner', 'admin'] }
]
