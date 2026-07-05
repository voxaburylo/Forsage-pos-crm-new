import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { ToastContainer } from '@/components/ui'
import { CommandPalette } from '@/components/CommandPalette'
import '@/stores/authStore'

const CHUNK_RELOAD_KEY = 'forsage_chunk_reload_at'

function ChunkLoadError() {
  async function recover() {
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY)
      const registrations = await navigator.serviceWorker?.getRegistrations()
      await Promise.all((registrations ?? []).map((registration) => registration.unregister()))
      const cacheNames = await caches?.keys()
      await Promise.all((cacheNames ?? []).map((name) => caches.delete(name)))
    } catch {
      // Навіть якщо очищення PWA-кешу недоступне, звичайне оновлення ще може допомогти.
    }
    window.location.reload()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-6">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-bold text-gray-900">Потрібно завершити оновлення</h1>
        <p className="mt-2 text-sm text-gray-500">
          Браузер зберіг стару версію одного з файлів програми. Дані магазину не пошкоджені.
        </p>
        <button
          type="button"
          onClick={recover}
          className="mt-5 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-black hover:bg-yellow-300"
        >
          Очистити кеш і відкрити програму
        </button>
      </div>
    </div>
  )
}

function lazyWithRetry(componentImport: () => Promise<any>) {
  return lazy(async () => {
    try {
      const component = await componentImport()
      sessionStorage.removeItem(CHUNK_RELOAD_KEY)
      return component
    } catch (error) {
      console.error('Failed to load application chunk', error)
      const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
      if (!lastReload || Date.now() - lastReload > 60_000) {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
        window.location.reload()
        return new Promise(() => {}) // Тримаємо loader лише під час єдиної спроби reload.
      }
      return { default: ChunkLoadError }
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
const ReceivingPage        = lazyWithRetry(() => import('@/features/receiving/ReceivingPage'))
const SupplierFormPage     = lazyWithRetry(() => import('@/features/suppliers/SupplierFormPage'))
const SupplierDetailPage   = lazyWithRetry(() => import('@/features/suppliers/SupplierDetailPage'))
const InvoicesPage         = lazyWithRetry(() => import('@/features/suppliers/InvoicesPage'))
const InvoiceFormPage      = lazyWithRetry(() => import('@/features/suppliers/InvoiceFormPage'))
const InvoiceDetailPage    = lazyWithRetry(() => import('@/features/suppliers/InvoiceDetailPage'))
const ImportPage           = lazyWithRetry(() => import('@/features/suppliers/ImportPage'))
const BulkImportPage       = lazyWithRetry(() => import('@/features/suppliers/BulkImportPage'))
const SupplierPricesPage   = lazyWithRetry(() => import('@/features/suppliers/SupplierPricesPage'))
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
const QuickDraftPage       = lazyWithRetry(() => import('@/features/quotes/QuickDraftPage'))
const CashflowPage         = lazyWithRetry(() => import('@/features/cashflow/CashflowPage'))
const ReservesList         = lazyWithRetry(() => import('@/features/inventory/ReservesList'))
const SupplierPOsPage      = lazyWithRetry(() => import('@/features/suppliers/SupplierPOsPage'))
const WarehousePicking     = lazyWithRetry(() => import('@/features/inventory/WarehousePicking'))
const WarehouseMovementPage = lazyWithRetry(() => import('@/features/inventory/WarehouseMovementPage'))
const InboxPage             = lazyWithRetry(() => import('@/features/notifications/InboxPage'))
const AutoPurchasePage      = lazyWithRetry(() => import('@/features/autoPurchase/AutoPurchasePage'))
const CoreReturnsPage       = lazyWithRetry(() => import('@/features/inventory/CoreReturnsPage'))
const AuditLogPage          = lazyWithRetry(() => import('@/features/admin/AuditLogPage'))
const TemplateEditor        = lazyWithRetry(() => import('@/features/notifications/TemplateEditor'))

const OFFICE_ROLES = ['owner', 'admin', 'manager']
const ADMIN_ROLES = ['owner', 'admin']
const WAREHOUSE_ROLES = ['owner', 'admin', 'storekeeper']
const INVENTORY_COUNTER_ROLES = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer']
const CATALOG_EDITOR_ROLES = ['owner', 'admin', 'manager', 'storekeeper']
const SUPPLIER_ROLES = ['owner', 'admin', 'manager', 'storekeeper']
const AiAssistantPage       = lazyWithRetry(() => import('@/features/ai/AiAssistantPage'))

function Loader() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-gray-400 text-sm">Завантаження...</div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route path="/dashboard"          element={<ProtectedRoute roles={OFFICE_ROLES}><DashboardPage /></ProtectedRoute>} />
          <Route path="/products"           element={<ProtectedRoute><ProductsPage /></ProtectedRoute>} />
          <Route path="/products/new"       element={<ProtectedRoute roles={CATALOG_EDITOR_ROLES}><ProductFormPage /></ProtectedRoute>} />
          <Route path="/products/:id"       element={<ProtectedRoute><ProductDetailPage /></ProtectedRoute>} />
          <Route path="/products/:id/edit"  element={<ProtectedRoute roles={CATALOG_EDITOR_ROLES}><ProductFormPage /></ProtectedRoute>} />

          <Route path="/customers"           element={<ProtectedRoute><CustomersPage /></ProtectedRoute>} />
          <Route path="/customers/new"       element={<ProtectedRoute><CustomerFormPage /></ProtectedRoute>} />
          <Route path="/customers/:id"       element={<ProtectedRoute><CustomerDetailPage /></ProtectedRoute>} />
          <Route path="/customers/:id/edit"  element={<ProtectedRoute roles={OFFICE_ROLES}><CustomerFormPage /></ProtectedRoute>} />

          <Route path="/pos"      element={<ProtectedRoute><POSPage /></ProtectedRoute>} />
          <Route path="/sales"     element={<ProtectedRoute><SalesPage /></ProtectedRoute>} />
          <Route path="/returns"  element={<ProtectedRoute><ReturnForm /></ProtectedRoute>} />
          <Route path="/cashflow" element={<ProtectedRoute><CashflowPage /></ProtectedRoute>} />
          <Route path="/reports"  element={<ProtectedRoute roles={OFFICE_ROLES}><DailyReport /></ProtectedRoute>} />
          <Route path="/abc"        element={<ProtectedRoute roles={OFFICE_ROLES}><ABCAnalysis /></ProtectedRoute>} />
          <Route path="/waitlist"   element={<ProtectedRoute roles={OFFICE_ROLES}><WaitlistPage /></ProtectedRoute>} />
          <Route path="/needs-action" element={<ProtectedRoute roles={OFFICE_ROLES}><NeedsActionPage /></ProtectedRoute>} />
          <Route path="/staff-analytics" element={<ProtectedRoute roles={ADMIN_ROLES}><StaffAnalytics /></ProtectedRoute>} />
          <Route path="/admin"    element={<ProtectedRoute roles={ADMIN_ROLES}><AdminPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute roles={ADMIN_ROLES}><SettingsPage /></ProtectedRoute>} />
          <Route path="/settings/draft-nomenclature" element={<ProtectedRoute roles={OFFICE_ROLES}><SupplierPricesPage /></ProtectedRoute>} />
          <Route path="/settings/draft-nomenclature/import" element={<ProtectedRoute roles={OFFICE_ROLES}><BulkImportPage /></ProtectedRoute>} />
          
          <Route path="/suppliers" element={<ProtectedRoute roles={SUPPLIER_ROLES}><SuppliersPage /></ProtectedRoute>} />
          <Route path="/suppliers/new" element={<ProtectedRoute roles={OFFICE_ROLES}><SupplierFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id" element={<ProtectedRoute roles={SUPPLIER_ROLES}><SupplierDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id/edit" element={<ProtectedRoute roles={OFFICE_ROLES}><SupplierFormPage /></ProtectedRoute>} />
          <Route path="/receiving" element={<ProtectedRoute roles={SUPPLIER_ROLES}><ReceivingPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices" element={<ProtectedRoute roles={SUPPLIER_ROLES}><InvoicesPage /></ProtectedRoute>} />
          <Route path="/suppliers/pos" element={<ProtectedRoute roles={OFFICE_ROLES}><SupplierPOsPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/new" element={<ProtectedRoute roles={SUPPLIER_ROLES}><InvoiceFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id" element={<ProtectedRoute roles={SUPPLIER_ROLES}><InvoiceDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id/edit" element={<ProtectedRoute roles={OFFICE_ROLES}><InvoiceFormPage /></ProtectedRoute>} />
          <Route path="/suppliers/import"            element={<ProtectedRoute roles={SUPPLIER_ROLES}><ImportPage /></ProtectedRoute>} />

          <Route path="/staff"          element={<ProtectedRoute roles={ADMIN_ROLES}><StaffPage /></ProtectedRoute>} />
          
          <Route path="/internal"       element={<ProtectedRoute roles={OFFICE_ROLES}><InternalConsumptionsPage /></ProtectedRoute>} />
          <Route path="/settings/channels" element={<ProtectedRoute roles={ADMIN_ROLES}><SettingsChannels /></ProtectedRoute>} />
          <Route path="/labels"  element={<ProtectedRoute roles={ADMIN_ROLES}><LabelDesigner /></ProtectedRoute>} />
          <Route path="/auto-purchase"   element={<ProtectedRoute roles={OFFICE_ROLES}><AutoPurchasePage /></ProtectedRoute>} />
          <Route path="/core-returns"    element={<ProtectedRoute roles={OFFICE_ROLES}><CoreReturnsPage /></ProtectedRoute>} />
          <Route path="/audit"           element={<ProtectedRoute roles={ADMIN_ROLES}><AuditLogPage /></ProtectedRoute>} />
          <Route path="/settings/templates" element={<ProtectedRoute roles={ADMIN_ROLES}><TemplateEditor /></ProtectedRoute>} />
          <Route path="/notifications"  element={<ProtectedRoute roles={OFFICE_ROLES}><InboxPage /></ProtectedRoute>} />
          <Route path="/ai-assistant"   element={<ProtectedRoute roles={OFFICE_ROLES}><AiAssistantPage /></ProtectedRoute>} />

          <Route path="/inventory"               element={<ProtectedRoute roles={INVENTORY_COUNTER_ROLES}><InventoryPage /></ProtectedRoute>} />
          <Route path="/inventory/picking"       element={<ProtectedRoute roles={['owner', 'admin', 'manager', 'storekeeper']}><WarehousePicking /></ProtectedRoute>} />
          <Route path="/inventory/:id"          element={<ProtectedRoute roles={INVENTORY_COUNTER_ROLES}><ActiveSession /></ProtectedRoute>} />
          <Route path="/inventory/reserves"      element={<ProtectedRoute roles={['owner', 'admin', 'manager', 'storekeeper']}><ReservesList /></ProtectedRoute>} />
          <Route path="/inventory/movements"     element={<ProtectedRoute roles={WAREHOUSE_ROLES}><WarehouseMovementPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs"     element={<ProtectedRoute roles={WAREHOUSE_ROLES}><WriteoffsPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs/new" element={<ProtectedRoute roles={WAREHOUSE_ROLES}><WriteoffFormPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs/:id" element={<ProtectedRoute roles={WAREHOUSE_ROLES}><WriteoffDetailPage /></ProtectedRoute>} />

          {/* Чат-боти — окремий розділ (той самий компонент у режимі chatMode) */}
          <Route path="/chats" element={<ProtectedRoute roles={OFFICE_ROLES}><OrdersPage /></ProtectedRoute>} />
          <Route path="/orders"          element={<ProtectedRoute roles={OFFICE_ROLES}><OrdersPage /></ProtectedRoute>} />
          <Route path="/orders/new"      element={<ProtectedRoute roles={OFFICE_ROLES}><OrderFormPage /></ProtectedRoute>} />
          <Route path="/orders/:id"      element={<ProtectedRoute roles={OFFICE_ROLES}><OrderDetailPage /></ProtectedRoute>} />
          <Route path="/orders/:id/edit" element={<ProtectedRoute roles={OFFICE_ROLES}><OrderFormPage /></ProtectedRoute>} />

          <Route path="/quotes"          element={<Navigate to="/orders" replace />} />
          <Route path="/quotes/new"      element={<ProtectedRoute roles={OFFICE_ROLES}><QuickDraftPage /></ProtectedRoute>} />
          <Route path="/quotes/:id"      element={<ProtectedRoute roles={OFFICE_ROLES}><QuickDraftPage /></ProtectedRoute>} />

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
      <ToastContainer />
      <CommandPalette />
    </BrowserRouter>
  )
}

export default App
