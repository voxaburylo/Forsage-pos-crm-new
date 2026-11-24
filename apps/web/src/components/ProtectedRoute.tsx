import { isDesktopRuntime } from '@/lib/desktopBridge'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useStaffRights, type StaffRight } from '@/lib/staffRights'

interface Props {
  children: React.ReactNode
  roles?: string[]
  /** 24.11.2026: право з картки працівника відкриває розділ і тому, кому роль його не дає. */
  right?: StaffRight
}

export function homePathForRole(role?: string, desktop = isDesktopRuntime()): string {
  if (!desktop) return '/products'
  if (role === 'sto_viewer') return '/inventory'
  if (role === 'tire_worker') return '/products'
  if (role === 'cashier') return '/pos'
  if (role === 'storekeeper') return '/inventory/picking'
  return ['owner', 'admin', 'manager'].includes(role ?? '') ? '/dashboard' : '/products'
}

export default function ProtectedRoute({ children, roles, right }: Props) {
  const { session, loading } = useAuthStore()
  const rights = useStaffRights()

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-gray-400 text-sm">Завантаження...</div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  const role = (session.user.app_metadata?.role as string | undefined) ?? 'cashier'
  if (roles && !roles.includes(role) && !(right && rights[right])) {
    return <Navigate to={homePathForRole(role)} replace />
  }

  return <>{children}</>
}
