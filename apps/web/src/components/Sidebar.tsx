import { useState, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Package, Users, ShoppingCart, RotateCcw,
  Truck, BarChart2, BarChart3, Settings, Zap, LogOut, Shield, FileText, Upload, Trash2, ScrollText, Tag, ClipboardList, Clock,
  ChevronDown, UserCog, Barcode, MessageSquare, DollarSign, ArrowDownLeft, Wallet, Percent, TrendingUp, ShieldCheck, ArrowRightLeft,
  Bell, Printer, ShoppingBag, FilePlus, X,
} from 'lucide-react'
import { signOut } from '@/lib/auth'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api'

interface NavItem {
  to: string
  icon: React.ReactNode
  label: string
  roles?: string[]
}

interface NavGroup {
  title?: string
  items: NavItem[]
  roles?: string[]
}

interface SidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: '/dashboard', icon: <LayoutDashboard size={18} />, label: 'Дашборд' },
      { to: '/pos',       icon: <Zap size={18} />,             label: 'Каса (POS)' },
    ],
  },
  {
    title: 'Каталог',
    items: [
      { to: '/products',  icon: <Package size={18} />, label: 'Товари' },
      { to: '/customers', icon: <Users size={18} />,   label: 'Клієнти' },
    ],
  },
  {
    items: [
      { to: '/orders',     icon: <ClipboardList size={18} />, label: 'Замовлення',       roles: ['owner','admin','manager'] },
      { to: '/quotes/new', icon: <FilePlus size={18} />,      label: 'Нова пропозиція',  roles: ['owner','admin','manager'] },
    ],
  },
  {
    title: 'Продажі',
    roles: ['owner', 'admin', 'manager', 'cashier'],
    items: [
      { to: '/sales',    icon: <ShoppingCart size={18} />, label: 'Журнал продажів', roles: ['owner','admin','manager'] },
      { to: '/returns',  icon: <RotateCcw size={18} />,    label: 'Повернення',      roles: ['owner','admin','manager'] },
      { to: '/cashflow', icon: <Wallet size={18} />,       label: 'Каса та витрати', roles: ['owner','admin','manager'] },
    ],
  },
  {
    title: 'Постачальники',
    roles: ['owner', 'admin', 'manager', 'storekeeper'],
    items: [
      { to: '/suppliers',           icon: <Truck size={18} />,    label: 'Список',        roles: ['owner','admin','manager'] },
      { to: '/suppliers/invoices',  icon: <FileText size={18} />, label: 'Накладні',      roles: ['owner','admin','manager','storekeeper'] },
      { to: '/suppliers/import',    icon: <Upload size={18} />,   label: 'Імпорт прайсу', roles: ['owner','admin','manager','storekeeper'] },
      { to: '/suppliers/1c-import', icon: <Upload size={18} />,   label: 'Імпорт з 1С',  roles: ['owner','admin','manager'] },
    ],
  },
  {
    title: 'Склад',
    roles: ['owner', 'admin', 'manager', 'storekeeper'],
    items: [
      { to: '/inventory',            icon: <ClipboardList size={18} />, label: 'Інвентаризація',  roles: ['owner','admin','manager','storekeeper'] },
      { to: '/inventory/picking',    icon: <Package size={18} />,       label: 'Складання (WMS)', roles: ['owner','admin','manager','storekeeper'] },
      { to: '/inventory/writeoffs',  icon: <Trash2 size={18} />,        label: 'Списання',        roles: ['owner','admin','manager','storekeeper'] },
      { to: '/internal',             icon: <ArrowDownLeft size={18} />, label: 'Внутр. відпуск',  roles: ['owner','admin','manager','storekeeper'] },
      { to: '/inventory/reserves',   icon: <Clock size={18} />,          label: 'Резерви товарів', roles: ['owner','admin','manager','storekeeper'] },
      { to: '/inventory/movements',  icon: <ArrowRightLeft size={18} />, label: 'Переміщення',    roles: ['owner','admin','manager','storekeeper'] },
    ],
  },
  {
    items: [
      { to: '/reports',             icon: <BarChart2 size={18} />,  label: 'Звіти',                     roles: ['owner','admin','manager'] },
      { to: '/abc',                 icon: <BarChart3 size={18} />,  label: 'ABC-аналіз',                roles: ['owner','admin','manager'] },
      { to: '/staff-kpi',           icon: <BarChart3 size={18} />,  label: 'KPI персоналу',             roles: ['owner','admin'] },
      { to: '/staff-profitability', icon: <TrendingUp size={18} />, label: 'Прибутковість працівників', roles: ['owner','admin'] },
      { to: '/waitlist',            icon: <Clock size={18} />,      label: 'Лист очікування',           roles: ['owner','admin','manager'] },
    ],
  },
  {
    title: 'Управління',
    roles: ['owner', 'admin'],
    items: [
      { to: '/staff',               icon: <UserCog size={18} />,       label: 'Команда',              roles: ['owner','admin'] },
      { to: '/staff-salary',        icon: <DollarSign size={18} />,    label: 'Нарахування ЗП',       roles: ['owner','admin'] },
      { to: '/settings/commission', icon: <Percent size={18} />,       label: 'Правила комісійних',   roles: ['owner','admin'] },
      { to: '/settings',            icon: <Settings size={18} />,      label: 'Налаштування',         roles: ['owner','admin'] },
      { to: '/settings/channels',   icon: <MessageSquare size={18} />, label: 'Канали зв\'язку',      roles: ['owner','admin'] },
      { to: '/settings/templates',  icon: <FileText size={18} />,      label: 'Шаблони сповіщень',    roles: ['owner','admin'] },
      { to: '/labels',              icon: <Barcode size={18} />,       label: 'Друк етикеток',        roles: ['owner','admin'] },
      { to: '/pricing',             icon: <Tag size={18} />,           label: 'Ціноутворення',        roles: ['owner','admin'] },
      { to: '/admin',               icon: <Shield size={18} />,        label: 'Користувачі',          roles: ['owner','admin'] },
      { to: '/audit',               icon: <ScrollText size={18} />,    label: 'Журнал дій',           roles: ['owner','admin'] },
      { to: '/stock-integrity',     icon: <ShieldCheck size={18} />,   label: 'Цілісність залишків',  roles: ['owner','admin'] },
      { to: '/notifications',       icon: <Bell size={18} />,          label: 'Сповіщення',           roles: ['owner','admin','manager'] },
      { to: '/print-center',        icon: <Printer size={18} />,       label: 'Центр друку',          roles: ['owner','admin','manager'] },
      { to: '/auto-purchase',       icon: <ShoppingBag size={18} />,   label: 'Автозакупки',          roles: ['owner','admin'] },
    ],
  },
]

// ── SidebarLink ───────────────────────────────────────────────────────────────

function SidebarLink({ item, badge, onClose }: { item: NavItem; badge?: number; onClose: () => void }) {
  return (
    <NavLink
      to={item.to}
      onClick={onClose}
      className={({ isActive }) =>
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
    (item) => !item.roles || item.roles.includes(role),
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

  return (
    <div>
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
      {open && (
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
  const { session } = useAuthStore()
  const role = (session?.user?.user_metadata?.role as string) ?? 'cashier'
  const [readyCount, setReadyCount]   = useState(0)
  const [pickingCount, setPickingCount] = useState(0)
  const [notifCount, setNotifCount]   = useState(0)

  useEffect(() => {
    const isStorekeeper = role === 'storekeeper'
    const isOffice = ['owner', 'admin', 'manager'].includes(role)
    if (!isOffice && !isStorekeeper) return

    function fetchReady() {
      if (isOffice) {
        api.get<{ data: any[] }>('/api/v1/customer-orders?status=ready&per_page=100', { silent: true } as any)
          .then((r) => setReadyCount((r.data ?? []).length))
          .catch(() => {})
      }
    }
    function fetchPicking() {
      api.get<{ data: any[] }>('/api/v1/picking/orders', { silent: true } as any)
        .then((r) => setPickingCount((r.data ?? []).length))
        .catch(() => {})
    }
    function fetchNotif() {
      api.get<{ data: { count: number } }>('/api/v1/notifications/inbox/count', { silent: true } as any)
        .then((r) => setNotifCount(r.data?.count ?? 0))
        .catch(() => {})
    }

    fetchReady(); fetchPicking(); fetchNotif()
    const t = setInterval(() => { fetchReady(); fetchPicking(); fetchNotif() }, 120_000)
    return () => clearInterval(t)
  }, [role])

  const badgeMap: Record<string, number> = {
    '/orders': readyCount,
    '/inventory/picking': pickingCount,
    '/notifications': notifCount,
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
        'md:relative md:z-auto md:translate-x-0',
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
