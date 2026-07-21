import { useState, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Package, ShoppingCart,
  Truck, BarChart2, Settings, Zap, LogOut, ClipboardList,
  ChevronDown, Tag, UserCog, Users,
  X, PackagePlus,
} from 'lucide-react'
import { signOut } from '@/lib/auth'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'

interface NavItem {
  to: string
  icon: React.ReactNode
  label: string
  roles?: string[]
  desktopHidden?: boolean
}

interface NavGroup {
  title?: string
  items: NavItem[]
  roles?: string[]
  collapsible?: boolean
}

interface SidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Головна',
    collapsible: false,
    items: [
      { to: '/pos',                 icon: <Zap size={18} />,             label: 'Каса (POS)' },
    ],
  },
  {
        title: 'Основне',
    collapsible: false,
    items: [
      { to: '/orders',              icon: <ClipboardList size={18} />,   label: 'Замовлення',           roles: ['owner','admin','manager'] },
      { to: '/products',            icon: <Package size={18} />,         label: 'Товари' },
      { to: '/customers',           icon: <Users size={18} />,           label: 'Клієнти' },
      { to: '/inventory/picking',   icon: <ClipboardList size={18} />,   label: 'Збірка замовлень',     roles: ['owner','admin','manager','storekeeper'] },
      { to: '/inventory',           icon: <Package size={18} />,         label: 'Інвентаризація',       roles: ['owner','admin','manager','storekeeper','cashier','sto_viewer'] },
      { to: '/suppliers/invoices',  icon: <PackagePlus size={18} />,     label: 'Поступлення товарів',  roles: ['owner','admin','manager','storekeeper'] },
      { to: '/labels',              icon: <Tag size={18} />,             label: 'Печать этикеток',       roles: ['owner','admin'] },
      { to: '/suppliers',           icon: <Truck size={18} />,           label: 'Постачальники',        roles: ['owner','admin','manager','storekeeper'] },
      { to: '/sales',               icon: <ShoppingCart size={18} />,    label: 'Продажі та фінанси',   roles: ['owner','admin','manager','cashier'] },
    ],
  },
  {
    title: 'Аналітика',
    roles: ['owner','admin','manager'],
    items: [
      { to: '/dashboard',           icon: <LayoutDashboard size={18} />, label: 'Дашборд',              roles: ['owner','admin','manager'] },
      { to: '/reports',             icon: <BarChart2 size={18} />,       label: 'Денний звіт',          roles: ['owner','admin'] },
    ],
  },
  {
    title: 'Адміністрування',
    roles: ['owner', 'admin'],
    items: [
      { to: '/staff',               icon: <UserCog size={18} />,         label: 'Команда та ЗП',        roles: ['owner','admin'] },
      { to: '/settings',            icon: <Settings size={18} />,        label: 'Налаштування',         roles: ['owner','admin'] },
    ],
  },
]

// ── SidebarLink ───────────────────────────────────────────────────────────────

function SidebarLink({ item, badge, onClose }: { item: NavItem; badge?: number; onClose: () => void }) {
  const location = useLocation()

  const isActive = (() => {
    if (item.to.includes('?')) {
      const [path, search] = item.to.split('?')
      const searchParams = new URLSearchParams(search)
      const currentParams = new URLSearchParams(location.search)

      const pathMatches = location.pathname === path
      const paramsMatch = Array.from(searchParams.entries()).every(
        ([key, val]) => currentParams.get(key) === val
      )
      return pathMatches && paramsMatch
    }

    if (item.to === '/dashboard') {
      return location.pathname === '/dashboard' || location.pathname === '/'
    }

    if (item.to === '/inventory') {
      return location.pathname === '/inventory'
        || (location.pathname.startsWith('/inventory/') && location.pathname !== '/inventory/picking')
    }

    return location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to + '/'))
  })()

  return (
    <NavLink
      to={item.to}
      onClick={onClose}
      className={
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
          isActive
            ? 'bg-yellow-50 text-yellow-700 font-medium'
            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-700'
        }`
      }
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {!!badge && badge > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500 text-white font-bold leading-none">
          {badge}
        </span>
      )}
    </NavLink>
  )
}

// ── NavSection ────────────────────────────────────────────────────────────────

function NavSection({
  group, role, badgeMap, onClose,
}: {
  group: NavGroup
  role: string
  badgeMap: Record<string, number>
  onClose: () => void
}) {
  const location = useLocation()

  const visibleItems = group.items.filter(
    (item) => (!item.desktopHidden || !desktopBridge()) && (!item.roles || item.roles.includes(role)),
  )

  const isGroupActive = visibleItems.some((item) => location.pathname.startsWith(item.to))
  const [open, setOpen] = useState(isGroupActive || !group.title)

  if (visibleItems.length === 0) return null
  if (group.roles && !group.roles.includes(role)) return null

  if (!group.title) {
    return (
      <div className="space-y-0.5">
        {visibleItems.map((item) => (
          <SidebarLink key={item.to} item={item} badge={badgeMap[item.to]} onClose={onClose} />
        ))}
      </div>
    )
  }

  const isCollapsible = group.collapsible !== false

  return (
    <div>
      {isCollapsible ? (
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center justify-between w-full px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-600 transition-colors"
        >
          {group.title}
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${open ? 'rotate-0' : '-rotate-90'}`}
          />
        </button>
      ) : (
        <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider select-none">
          {group.title}
        </div>
      )}
      {(open || !isCollapsible) && (
        <div className="space-y-0.5 mt-0.5">
          {visibleItems.map((item) => (
            <SidebarLink key={item.to} item={item} badge={badgeMap[item.to]} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export function Sidebar({ isOpen = false, onClose = () => {} }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useAuthStore()
  const role = (session?.user?.user_metadata?.role as string) ?? 'cashier'

  const [pickingCount, setPickingCount] = useState(0)

  useEffect(() => {
    const isStorekeeper = role === 'storekeeper'
    const isOffice = ['owner', 'admin', 'manager'].includes(role)
    if (!isOffice && !isStorekeeper) return


    function fetchPicking() {
      const local = desktopBridge()?.orders?.list
      if (local) {
        local({ limit: 500, offset: 0 })
          .then((rows) => setPickingCount((rows ?? []).filter((order: any) => !['completed', 'canceled'].includes(order.status)).length))
          .catch(() => {})
        return
      }
      api.get<{ data: any[] }>('/api/v1/picking/orders', { silent: true } as any)
        .then((r) => setPickingCount((r.data ?? []).length))
        .catch(() => {})
    }
    fetchPicking()
    const t = setInterval(fetchPicking, 120_000)
    return () => clearInterval(t)
  }, [role, location.pathname, location.search])

  const badgeMap: Record<string, number> = {
    '/inventory/picking': pickingCount,
  }

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <aside
      className={[
        'fixed inset-y-0 left-0 z-30 w-64 md:w-56 bg-white border-r border-gray-100 flex flex-col',
        'transition-transform duration-200 ease-in-out',
        'md:sticky md:top-0 md:bottom-auto md:h-screen md:self-start md:z-auto md:translate-x-0',
        isOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
      ].join(' ')}
    >
      {/* Logo + close button */}
      <div className="px-4 py-4 border-b border-gray-100 flex items-center justify-between pt-safe">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-accent rounded-lg flex items-center justify-center shrink-0">
            <Zap size={16} className="text-black" />
          </div>
          <div>
            <div className="font-bold text-gray-900 text-sm leading-tight">Форсаж</div>
            <div className="text-xs text-gray-400 leading-tight">CRM / ERP</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="md:hidden p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          aria-label="Закрити меню"
        >
          <X size={20} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-3 overflow-y-auto">
        {NAV_GROUPS.map((group, idx) => (
          <NavSection
            key={group.title ?? idx}
            group={group}
            role={role}
            badgeMap={badgeMap}
            onClose={onClose}
          />
        ))}
      </nav>

      {/* Sign out */}
      <div className="px-2 py-3 border-t border-gray-100 pb-safe">
        <button
          onClick={handleSignOut}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 w-full transition-colors"
        >
          <LogOut size={18} />
          Вийти
        </button>
      </div>
    </aside>
  )
}
