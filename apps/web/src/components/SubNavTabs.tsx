import { Link, useLocation } from 'react-router-dom'

interface TabItem {
  label: string
  to: string
  roles?: string[]
}

interface SubNavTabsProps {
  tabs: TabItem[]
  currentRole?: string
}

export function SubNavTabs({ tabs, currentRole }: SubNavTabsProps) {
  const location = useLocation()

  const visibleTabs = tabs.filter(
    (tab) => !tab.roles || !currentRole || tab.roles.includes(currentRole)
  )

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
    <div className="flex border-b border-gray-100 overflow-x-auto mb-6 -mx-4 px-4 md:-mx-6 md:px-6 bg-white shrink-0 sticky top-0 z-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex space-x-6">
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
            if (tab.to === '/suppliers' || tab.to === '/products' || tab.to === '/sales' || tab.to === '/inventory' || tab.to === '/reports' || tab.to === '/staff' || tab.to === '/settings') {
              return location.pathname === tab.to
            }
            return location.pathname === tab.to || (tab.to !== '/' && location.pathname.startsWith(tab.to + '/'))
          })()

          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`py-3.5 px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-all duration-200 ${
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

export const PRODUCTS_TABS = [
  { to: '/products', label: 'Товари' },
  { to: '/customers', label: 'Клієнти' },
  { to: '/pricing', label: 'Ціноутворення', roles: ['owner', 'admin'] },
  { to: '/labels', label: 'Друк етикеток', roles: ['owner', 'admin'] }
]

export const ORDERS_TABS = [
  { to: '/needs-action', label: 'Потребує дії' },
  { to: '/orders', label: 'Список замовлень' },
  { to: '/orders?tab=drafts', label: 'Чернетки / КП' },
  { to: '/orders?tab=bots', label: 'Боти / Месенджер' },
  { to: '/waitlist', label: 'Лист очікування' }
]

export const FINANCE_TABS = [
  { to: '/sales', label: 'Журнал продажів' },
  { to: '/returns', label: 'Повернення' },
  { to: '/cashflow', label: 'Каса та витрати' }
]

export const SUPPLIERS_TABS = [
  { to: '/suppliers', label: 'Список постачальників', roles: ['owner', 'admin', 'manager'] },
  { to: '/suppliers/invoices', label: 'Прихідні накладні' },
  { to: '/suppliers/pos', label: 'Замовлення постачальникам' },
  { to: '/suppliers/import', label: 'Імпорт прайсу' },
  { to: '/suppliers/prices', label: 'Прайси постачальників' },
  { to: '/suppliers/1c-import', label: 'Імпорт з 1С', roles: ['owner', 'admin', 'manager'] },
  { to: '/auto-purchase', label: 'Автозакупки', roles: ['owner', 'admin'] }
]

export const INVENTORY_TABS = [
  { to: '/inventory', label: 'Інвентаризація' },
  { to: '/inventory/picking', label: 'Збірка замовлень (WMS)' },
  { to: '/inventory/writeoffs', label: 'Списання' },
  { to: '/internal', label: 'Внутр. відпуск' },
  { to: '/inventory/movements', label: 'Переміщення' },
  { to: '/inventory/reserves', label: 'Резерви товарів' },
  { to: '/inventory/core-returns', label: 'Повернення серцевин' }
]

export const ANALYTICS_TABS = [
  { to: '/dashboard', label: 'Дашборд', roles: ['owner', 'admin', 'manager'] },
  { to: '/reports', label: 'Денний звіт', roles: ['owner', 'admin', 'manager'] },
  { to: '/abc', label: 'ABC-аналіз', roles: ['owner', 'admin', 'manager'] }
]

export const STAFF_TABS = [
  { to: '/staff', label: 'Команда та ЗП', roles: ['owner', 'admin'] },
  { to: '/staff-analytics', label: 'Аналітика персоналу', roles: ['owner', 'admin'] }
]

export const SETTINGS_TABS = [
  { to: '/settings', label: 'Загальні', roles: ['owner', 'admin'] },
  { to: '/settings/channels', label: 'Канали зв\'язку', roles: ['owner', 'admin'] },
  { to: '/settings/templates', label: 'Шаблони', roles: ['owner', 'admin'] },
  { to: '/print-center', label: 'Центр друку', roles: ['owner', 'admin', 'manager'] },
  { to: '/audit', label: 'Журнал дій', roles: ['owner', 'admin'] },
  { to: '/stock-integrity', label: 'Цілісність залишків', roles: ['owner', 'admin'] }
]
