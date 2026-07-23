import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

interface Props {
  children: React.ReactNode
  roles?: string[]
}

export function homePathForRole(role?: string): string {
  if (role === 'cashier') return '/pos'
  if (role === 'storekeeper') return '/inventory/picking'
  return '/dashboard'
}

export default function ProtectedRoute({ children, roles }: Props) {
  const { session, loading } = useAuthStore()

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
  if (roles && !roles.includes(role)) {
    return <Navigate to={homePathForRole(role)} replace />
  }

  return <>{children}</>
}
