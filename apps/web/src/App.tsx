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
const SettingsPage         = lazy(() => import('@/features/settings/SettingsPage'))
const CommissionRulesPage  = lazy(() => import('@/features/settings/CommissionRulesPage'))
const SuppliersPage        = lazy(() => import('@/features/suppliers/SuppliersPage'))
const SupplierFormPage     = lazy(() => import('@/features/suppliers/SupplierFormPage'))
const SupplierDetailPage   = lazy(() => import('@/features/suppliers/SupplierDetailPage'))
const InvoicesPage         = lazy(() => import('@/features/suppliers/InvoicesPage'))
const InvoiceFormPage      = lazy(() => import('@/features/suppliers/InvoiceFormPage'))
const InvoiceDetailPage    = lazy(() => import('@/features/suppliers/InvoiceDetailPage'))
const ImportPage           = lazy(() => import('@/features/suppliers/ImportPage'))
const BulkImportPage       = lazy(() => import('@/features/suppliers/BulkImportPage'))
const OnecImportPage       = lazy(() => import('@/features/suppliers/OnecImportPage'))
const AuditLogPage         = lazy(() => import('@/features/admin/AuditLogPage'))
const PricingPage          = lazy(() => import('@/features/admin/PricingPage'))
const StockIntegrityPage   = lazy(() => import('@/features/admin/StockIntegrityPage'))
const WriteoffsPage        = lazy(() => import('@/features/inventory/WriteoffsPage'))
const WriteoffFormPage     = lazy(() => import('@/features/inventory/WriteoffFormPage'))
const WriteoffDetailPage   = lazy(() => import('@/features/inventory/WriteoffDetailPage'))
const StaffPage            = lazy(() => import('@/features/staff/StaffPage'))
const StaffSalaryPage      = lazy(() => import('@/features/staff/StaffSalaryPage'))
const InternalConsumptionsPage = lazy(() => import('@/features/inventory/InternalConsumptionsPage'))
const ABCAnalysis          = lazy(() => import('@/features/analytics/ABCAnalysis'))
const StaffKPI             = lazy(() => import('@/features/analytics/StaffKPI'))
const StaffProfitabilityReport = lazy(() => import('@/features/analytics/StaffProfitabilityReport'))
const WaitlistPage         = lazy(() => import('@/features/waitlist/WaitlistPage'))
const SettingsChannels     = lazy(() => import('@/features/chats/SettingsChannels'))
const InventoryPage        = lazy(() => import('@/features/inventory/InventoryPage'))
const ActiveSession        = lazy(() => import('@/features/inventory/ActiveSession'))
const LabelDesigner        = lazy(() => import('@/features/labels/LabelDesigner'))
const OrdersPage           = lazy(() => import('@/features/orders/OrdersPage'))
const OrderFormPage        = lazy(() => import('@/features/orders/OrderFormPage'))
const OrderDetailPage      = lazy(() => import('@/features/orders/OrderDetailPage'))
const QuoteEditorPage      = lazy(() => import('@/features/quotes/QuoteEditorPage'))
const CashflowPage         = lazy(() => import('@/features/cashflow/CashflowPage'))
const ReservesList         = lazy(() => import('@/features/inventory/ReservesList'))
const WarehousePicking     = lazy(() => import('@/features/inventory/WarehousePicking'))
const WarehouseMovementPage = lazy(() => import('@/features/inventory/WarehouseMovementPage'))
const InboxPage             = lazy(() => import('@/features/notifications/InboxPage'))
const PrintCenterPage       = lazy(() => import('@/features/print/PrintCenterPage'))
const AutoPurchasePage      = lazy(() => import('@/features/autoPurchase/AutoPurchasePage'))

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
          <Route path="/staff-kpi"  element={<ProtectedRoute><StaffKPI /></ProtectedRoute>} />
          <Route path="/staff-profitability" element={<ProtectedRoute><StaffProfitabilityReport /></ProtectedRoute>} />
          <Route path="/admin"    element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="/settings/commission" element={<ProtectedRoute><CommissionRulesPage /></ProtectedRoute>} />
          <Route path="/suppliers" element={<ProtectedRoute><SuppliersPage /></ProtectedRoute>} />
          <Route path="/suppliers/new" element={<ProtectedRoute><SupplierFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id" element={<ProtectedRoute><SupplierDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id/edit" element={<ProtectedRoute><SupplierFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices" element={<ProtectedRoute><InvoicesPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/new" element={<ProtectedRoute><InvoiceFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id" element={<ProtectedRoute><InvoiceDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id/edit" element={<ProtectedRoute><InvoiceFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/import"            element={<ProtectedRoute><ImportPage /></ProtectedRoute>} />
          <Route path="/suppliers/bulk-import"       element={<ProtectedRoute><BulkImportPage /></ProtectedRoute>} />
          <Route path="/suppliers/1c-import"         element={<ProtectedRoute><OnecImportPage /></ProtectedRoute>} />

          <Route path="/staff"          element={<ProtectedRoute><StaffPage /></ProtectedRoute>} />
          <Route path="/staff-salary"   element={<ProtectedRoute><StaffSalaryPage /></ProtectedRoute>} />
          <Route path="/internal"       element={<ProtectedRoute><InternalConsumptionsPage /></ProtectedRoute>} />
          <Route path="/audit"            element={<ProtectedRoute><AuditLogPage /></ProtectedRoute>} />
          <Route path="/settings/channels" element={<ProtectedRoute><SettingsChannels /></ProtectedRoute>} />
          <Route path="/labels"  element={<ProtectedRoute><LabelDesigner /></ProtectedRoute>} />
          <Route path="/pricing" element={<ProtectedRoute><PricingPage /></ProtectedRoute>} />
          <Route path="/stock-integrity" element={<ProtectedRoute><StockIntegrityPage /></ProtectedRoute>} />
          <Route path="/notifications"  element={<ProtectedRoute><InboxPage /></ProtectedRoute>} />
          <Route path="/print-center"   element={<ProtectedRoute><PrintCenterPage /></ProtectedRoute>} />
          <Route path="/auto-purchase"  element={<ProtectedRoute><AutoPurchasePage /></ProtectedRoute>} />

          <Route path="/inventory"               element={<ProtectedRoute><InventoryPage /></ProtectedRoute>} />
          <Route path="/inventory/picking"       element={<ProtectedRoute><WarehousePicking /></ProtectedRoute>} />
          <Route path="/inventory/:id"          element={<ProtectedRoute><ActiveSession /></ProtectedRoute>} />
          <Route path="/inventory/reserves"      element={<ProtectedRoute><ReservesList /></ProtectedRoute>} />
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
