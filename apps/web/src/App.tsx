import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { ToastContainer } from '@/components/ui'
import '@/stores/authStore'

const LoginPage            = lazy(() => import('@/pages/LoginPage'))
const DashboardPage        = lazy(() => import('@/pages/DashboardPage'))
const ProductsPage         = lazy(() => import('@/features/products/ProductsPage'))
const ProductFormPage      = lazy(() => import('@/features/products/ProductFormPage'))
const ProductDetailPage    = lazy(() => import('@/features/products/ProductDetailPage'))
const CustomersPage        = lazy(() => import('@/features/customers/CustomersPage'))
const CustomerFormPage     = lazy(() => import('@/features/customers/CustomerFormPage'))
const CustomerDetailPage   = lazy(() => import('@/features/customers/CustomerDetailPage'))
const POSPage              = lazy(() => import('@/features/pos/POSPage'))
const SalesPage            = lazy(() => import('@/features/sales/SalesPage'))
const ReturnForm           = lazy(() => import('@/features/pos/ReturnForm'))
const DailyReport          = lazy(() => import('@/features/reports/DailyReport'))
const AdminPage            = lazy(() => import('@/features/admin/AdminPage'))
const SettingsPage         = lazy(() => import('@/features/admin/SettingsPage'))

function Loader() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-gray-400 text-sm">Завантаження...</div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route path="/dashboard"          element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/products"           element={<ProtectedRoute><ProductsPage /></ProtectedRoute>} />
          <Route path="/products/new"       element={<ProtectedRoute><ProductFormPage /></ProtectedRoute>} />
          <Route path="/products/:id"       element={<ProtectedRoute><ProductDetailPage /></ProtectedRoute>} />
          <Route path="/products/:id/edit"  element={<ProtectedRoute><ProductFormPage /></ProtectedRoute>} />

          <Route path="/customers"           element={<ProtectedRoute><CustomersPage /></ProtectedRoute>} />
          <Route path="/customers/new"       element={<ProtectedRoute><CustomerFormPage /></ProtectedRoute>} />
          <Route path="/customers/:id"       element={<ProtectedRoute><CustomerDetailPage /></ProtectedRoute>} />
          <Route path="/customers/:id/edit"  element={<ProtectedRoute><CustomerFormPage /></ProtectedRoute>} />

          <Route path="/pos"      element={<ProtectedRoute><POSPage /></ProtectedRoute>} />
          <Route path="/sales"    element={<ProtectedRoute><SalesPage /></ProtectedRoute>} />
          <Route path="/returns"  element={<ProtectedRoute><ReturnForm /></ProtectedRoute>} />
          <Route path="/reports"  element={<ProtectedRoute><DailyReport /></ProtectedRoute>} />
          <Route path="/admin"    element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
      <ToastContainer />
    </BrowserRouter>
  )
}

export default App
