import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Package, Users, ShoppingCart, RotateCcw,
  Truck, BarChart2, Settings, Zap, LogOut, Shield,
} from 'lucide-react'
import { signOut } from '@/lib/auth'
import { useAuthStore } from '@/stores/authStore'

interface NavItem {
  to: string
  icon: React.ReactNode
  label: string
  roles?: string[]
}

const NAV: NavItem[] = [
  { to: '/dashboard',  icon: <LayoutDashboard size={18} />, label: 'Дашборд' },
  { to: '/pos',        icon: <Zap size={18} />,             label: 'Каса (POS)' },
  { to: '/products',   icon: <Package size={18} />,         label: 'Товари' },
  { to: '/customers',  icon: <Users size={18} />,           label: 'Клієнти' },
  { to: '/sales',      icon: <ShoppingCart size={18} />,    label: 'Продажі',       roles: ['owner','admin','manager'] },
  { to: '/returns',    icon: <RotateCcw size={18} />,       label: 'Повернення',    roles: ['owner','admin','manager'] },
  { to: '/suppliers',  icon: <Truck size={18} />,           label: 'Постачальники', roles: ['owner','admin','manager'] },
  { to: '/reports',    icon: <BarChart2 size={18} />,       label: 'Звіти',         roles: ['owner','admin','manager'] },
  { to: '/admin',      icon: <Shield size={18} />,          label: 'Адмін',         roles: ['owner','admin'] },
  { to: '/settings',   icon: <Settings size={18} />,        label: 'Налаштування',  roles: ['owner','admin'] },
]

export function Sidebar() {
  const navigate = useNavigate()
  const { session } = useAuthStore()
  const role = (session?.user?.user_metadata?.role as string) ?? 'cashier'

  const visible = NAV.filter((item) => !item.roles || item.roles.includes(role))

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <aside className="w-56 bg-white border-r border-gray-100 flex flex-col min-h-screen">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-accent rounded-lg flex items-center justify-center">
            <Zap size={16} className="text-black" />
          </div>
          <div>
            <div className="font-bold text-gray-900 text-sm leading-tight">Форсаж</div>
            <div className="text-xs text-gray-400 leading-tight">CRM / ERP</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {visible.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `
              flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
              ${isActive
                ? 'bg-[#FFD000]/20 text-yellow-900 font-semibold'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }
            `}
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      <div className="px-2 py-3 border-t border-gray-100">
        <button
          onClick={handleSignOut}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 w-full transition-colors"
        >
          <LogOut size={18} />
          Вийти
        </button>
      </div>
    </aside>
  )
}
