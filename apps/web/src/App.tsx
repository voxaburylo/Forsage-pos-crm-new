import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { ToastContainer } from '@/components/ui'
import '@/stores/authStore'

function lazyWithRetry(componentImport: () => Promise<any>) {
  return lazy(async () => {
    try {
      return await componentImport()
    } catch (error) {
      console.error('Failed to load chunk, reloading page...', error)
      window.location.reload()
      return new Promise(() => {}) // Keep loader active during reload
    }
  })
}

const LoginPage            = lazyWithRetry(() => import('@/pages/LoginPage'))
const DashboardPage        = lazyWithRetry(() => import('@/pages/DashboardPage'))
const ProductsPage         = lazyWithRetry(() => import('@/features/products/ProductsPage'))
const ProductFormPage      = lazyWithRetry(() => import('@/features/products/ProductFormPage'))
const ProductDetailPage    = lazyWithRetry(() => import('@/features/products/ProductDetailPage'))
const CustomersPage        = lazyWithRetry(() => import('@/features/customers/CustomersPage'))
const CustomerFormPage     = lazyWithRetry(() => import('@/features/customers/CustomerFormPage'))
const CustomerDetailPage   = lazyWithRetry(() => import('@/features/customers/CustomerDetailPage'))
const POSPage              = lazyWithRetry(() => import('@/features/pos/POSPage'))
const SalesPage            = lazyWithRetry(() => import('@/features/sales/SalesPage'))
const ReturnForm           = lazyWithRetry(() => import('@/features/pos/ReturnForm'))
const DailyReport          = lazyWithRetry(() => import('@/features/reports/DailyReport'))
const AdminPage            = lazyWithRetry(() => import('@/features/admin/AdminPage'))
const SettingsPage         = lazyWithRetry(() => import('@/features/settings/SettingsPage'))
// CommissionRulesPage merged
const SuppliersPage        = lazyWithRetry(() => import('@/features/suppliers/SuppliersPage'))
const SupplierFormPage     = lazyWithRetry(() => import('@/features/suppliers/SupplierFormPage'))
const SupplierDetailPage   = lazyWithRetry(() => import('@/features/suppliers/SupplierDetailPage'))
const InvoicesPage         = lazyWithRetry(() => import('@/features/suppliers/InvoicesPage'))
const InvoiceFormPage      = lazyWithRetry(() => import('@/features/suppliers/InvoiceFormPage'))
const InvoiceDetailPage    = lazyWithRetry(() => import('@/features/suppliers/InvoiceDetailPage'))
const ImportPage           = lazyWithRetry(() => import('@/features/suppliers/ImportPage'))
const AuditLogPage         = lazyWithRetry(() => import('@/features/admin/AuditLogPage'))
const PricingPage          = lazyWithRetry(() => import('@/features/admin/PricingPage'))
const StockIntegrityPage   = lazyWithRetry(() => import('@/features/admin/StockIntegrityPage'))
const WriteoffsPage        = lazyWithRetry(() => import('@/features/inventory/WriteoffsPage'))
const WriteoffFormPage     = lazyWithRetry(() => import('@/features/inventory/WriteoffFormPage'))
const WriteoffDetailPage   = lazyWithRetry(() => import('@/features/inventory/WriteoffDetailPage'))
const StaffPage            = lazyWithRetry(() => import('@/features/staff/StaffPage'))
// StaffSalaryPage merged
const InternalConsumptionsPage = lazyWithRetry(() => import('@/features/inventory/InternalConsumptionsPage'))
const ABCAnalysis          = lazyWithRetry(() => import('@/features/analytics/ABCAnalysis'))
const StaffAnalytics       = lazyWithRetry(() => import('@/features/analytics/StaffAnalytics'))
const WaitlistPage         = lazyWithRetry(() => import('@/features/waitlist/WaitlistPage'))
const SettingsChannels     = lazyWithRetry(() => import('@/features/chats/SettingsChannels'))
const InventoryPage        = lazyWithRetry(() => import('@/features/inventory/InventoryPage'))
const ActiveSession        = lazyWithRetry(() => import('@/features/inventory/ActiveSession'))
const LabelDesigner        = lazyWithRetry(() => import('@/features/labels/LabelDesigner'))
const OrdersPage           = lazyWithRetry(() => import('@/features/orders/OrdersPage'))
const NeedsActionPage      = lazyWithRetry(() => import('@/features/orders/NeedsActionPage'))
const OrderFormPage        = lazyWithRetry(() => import('@/features/orders/OrderFormPage'))
const OrderDetailPage      = lazyWithRetry(() => import('@/features/orders/OrderDetailPage'))
const QuoteEditorPage      = lazyWithRetry(() => import('@/features/quotes/QuoteEditorPage'))
const CashflowPage         = lazyWithRetry(() => import('@/features/cashflow/CashflowPage'))
const ReservesList         = lazyWithRetry(() => import('@/features/inventory/ReservesList'))
const CoreReturnsPage      = lazyWithRetry(() => import('@/features/inventory/CoreReturnsPage'))
const SupplierPOsPage      = lazyWithRetry(() => import('@/features/suppliers/SupplierPOsPage'))
const WarehousePicking     = lazyWithRetry(() => import('@/features/inventory/WarehousePicking'))
const WarehouseMovementPage = lazyWithRetry(() => import('@/features/inventory/WarehouseMovementPage'))
const InboxPage             = lazyWithRetry(() => import('@/features/notifications/InboxPage'))
const TemplateEditor        = lazyWithRetry(() => import('@/features/notifications/TemplateEditor'))
const PrintCenterPage       = lazyWithRetry(() => import('@/features/print/PrintCenterPage'))

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
          <Route path="/sales"     element={<ProtectedRoute><SalesPage /></ProtectedRoute>} />
          <Route path="/returns"  element={<ProtectedRoute><ReturnForm /></ProtectedRoute>} />
          <Route path="/cashflow" element={<ProtectedRoute><CashflowPage /></ProtectedRoute>} />
          <Route path="/reports"  element={<ProtectedRoute><DailyReport /></ProtectedRoute>} />
          <Route path="/abc"        element={<ProtectedRoute><ABCAnalysis /></ProtectedRoute>} />
          <Route path="/waitlist"   element={<ProtectedRoute><WaitlistPage /></ProtectedRoute>} />
          <Route path="/needs-action" element={<ProtectedRoute><NeedsActionPage /></ProtectedRoute>} />
<Route path="/staff-analytics" element={<ProtectedRoute><StaffAnalytics /></ProtectedRoute>} />
          <Route path="/admin"    element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          
          <Route path="/suppliers" element={<ProtectedRoute><SuppliersPage /></ProtectedRoute>} />
          <Route path="/suppliers/new" element={<ProtectedRoute><SupplierFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id" element={<ProtectedRoute><SupplierDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id/edit" element={<ProtectedRoute><SupplierFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices" element={<ProtectedRoute><InvoicesPage /></ProtectedRoute>} />
          <Route path="/suppliers/pos" element={<ProtectedRoute><SupplierPOsPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/new" element={<ProtectedRoute><InvoiceFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id" element={<ProtectedRoute><InvoiceDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id/edit" element={<ProtectedRoute><InvoiceFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/import"            element={<ProtectedRoute><ImportPage /></ProtectedRoute>} />

          <Route path="/staff"          element={<ProtectedRoute><StaffPage /></ProtectedRoute>} />
          
          <Route path="/internal"       element={<ProtectedRoute><InternalConsumptionsPage /></ProtectedRoute>} />
          <Route path="/audit"            element={<ProtectedRoute><AuditLogPage /></ProtectedRoute>} />
          <Route path="/settings/channels" element={<ProtectedRoute><SettingsChannels /></ProtectedRoute>} />
          <Route path="/labels"  element={<ProtectedRoute><LabelDesigner /></ProtectedRoute>} />
          <Route path="/pricing" element={<ProtectedRoute><PricingPage /></ProtectedRoute>} />
          <Route path="/stock-integrity" element={<ProtectedRoute><StockIntegrityPage /></ProtectedRoute>} />
          <Route path="/notifications"  element={<ProtectedRoute><InboxPage /></ProtectedRoute>} />
          <Route path="/settings/templates" element={<ProtectedRoute><TemplateEditor /></ProtectedRoute>} />
          <Route path="/print-center"   element={<ProtectedRoute><PrintCenterPage /></ProtectedRoute>} />

          <Route path="/inventory"               element={<ProtectedRoute><InventoryPage /></ProtectedRoute>} />
          <Route path="/inventory/picking"       element={<ProtectedRoute><WarehousePicking /></ProtectedRoute>} />
          <Route path="/inventory/:id"          element={<ProtectedRoute><ActiveSession /></ProtectedRoute>} />
          <Route path="/inventory/reserves"      element={<ProtectedRoute><ReservesList /></ProtectedRoute>} />
          <Route path="/inventory/core-returns" element={<ProtectedRoute><CoreReturnsPage /></ProtectedRoute>} />
          <Route path="/inventory/movements"     element={<ProtectedRoute><WarehouseMovementPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs"     element={<ProtectedRoute><WriteoffsPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs/new" element={<ProtectedRoute><WriteoffFormPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs/:id" element={<ProtectedRoute><WriteoffDetailPage /></ProtectedRoute>} />

          {/* Старий URL /chats — тепер усе в /orders */}
          <Route path="/chats" element={<Navigate to="/orders" replace />} />
          <Route path="/orders"          element={<ProtectedRoute><OrdersPage /></ProtectedRoute>} />
          <Route path="/orders/new"      element={<ProtectedRoute><OrderFormPage /></ProtectedRoute>} />
          <Route path="/orders/:id"      element={<ProtectedRoute><OrderDetailPage /></ProtectedRoute>} />
          <Route path="/orders/:id/edit" element={<ProtectedRoute><OrderFormPage /></ProtectedRoute>} />

          <Route path="/quotes"          element={<Navigate to="/orders" replace />} />
          <Route path="/quotes/new"      element={<ProtectedRoute><QuoteEditorPage /></ProtectedRoute>} />
          <Route path="/quotes/:id"      element={<ProtectedRoute><QuoteEditorPage /></ProtectedRoute>} />

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
      <ToastContainer />
    </BrowserRouter>
  )
}

export default App

