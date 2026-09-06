import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { TillOnly } from '@/components/TillOnly'
import { ToastContainer } from '@/components/ui'
import { CommandPalette } from '@/components/CommandPalette'
import { LocalSyncAgent } from '@/components/LocalSyncAgent'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

function lazyPage(componentImport: () => Promise<any>) {
  return lazy(componentImport)
}

const LoginPage            = lazyPage(() => import('@/pages/LoginPage'))
const DashboardPage        = lazyPage(() => import('@/pages/DashboardPage'))
const ProductsPage         = lazyPage(() => import('@/features/products/ProductsPage'))
const ProductFormPage      = lazyPage(() => import('@/features/products/ProductFormPage'))
const ProductDetailPage    = lazyPage(() => import('@/features/products/ProductDetailPage'))
const CustomersPage        = lazyPage(() => import('@/features/customers/CustomersPage'))
const CustomerFormPage     = lazyPage(() => import('@/features/customers/CustomerFormPage'))
const CustomerDetailPage   = lazyPage(() => import('@/features/customers/CustomerDetailPage'))
const POSPage              = lazyPage(() => import('@/features/pos/POSPage'))
const SalesPage            = lazyPage(() => import('@/features/sales/SalesPage'))
const ReturnForm           = lazyPage(() => import('@/features/pos/ReturnForm'))
const DailyReport          = lazyPage(() => import('@/features/reports/DailyReport'))
const PayrollPage          = lazyPage(() => import('@/features/analytics/PayrollPage'))
const AdminPage            = lazyPage(() => import('@/features/admin/AdminPage'))
const SettingsPage         = lazyPage(() => import('@/features/settings/SettingsPage'))
// CommissionRulesPage merged
const SuppliersPage        = lazyPage(() => import('@/features/suppliers/SuppliersPage'))
const ReceivingPage        = lazyPage(() => import('@/features/receiving/ReceivingPage'))
const SupplierFormPage     = lazyPage(() => import('@/features/suppliers/SupplierFormPage'))
const SupplierDetailPage   = lazyPage(() => import('@/features/suppliers/SupplierDetailPage'))
const InvoicesPage         = lazyPage(() => import('@/features/suppliers/InvoicesPage'))
const InvoiceFormPage      = lazyPage(() => import('@/features/suppliers/InvoiceFormPage'))
const InvoiceDetailPage    = lazyPage(() => import('@/features/suppliers/InvoiceDetailPage'))
const BulkImportPage       = lazyPage(() => import('@/features/suppliers/BulkImportPage'))
const SupplierPricesPage   = lazyPage(() => import('@/features/suppliers/SupplierPricesPage'))
const WriteoffsPage        = lazyPage(() => import('@/features/inventory/WriteoffsPage'))
const WriteoffFormPage     = lazyPage(() => import('@/features/inventory/WriteoffFormPage'))
const WriteoffDetailPage   = lazyPage(() => import('@/features/inventory/WriteoffDetailPage'))
const StaffPage            = lazyPage(() => import('@/features/staff/StaffPage'))
// StaffSalaryPage merged
const InternalConsumptionsPage = lazyPage(() => import('@/features/inventory/InternalConsumptionsPage'))
const ABCAnalysis          = lazyPage(() => import('@/features/analytics/ABCAnalysis'))
const StaffAnalytics       = lazyPage(() => import('@/features/analytics/StaffAnalytics'))
const WaitlistPage         = lazyPage(() => import('@/features/waitlist/WaitlistPage'))
const SettingsChannels     = lazyPage(() => import('@/features/chats/SettingsChannels'))
const InventoryPage        = lazyPage(() => import('@/features/inventory/InventoryPage'))
const ActiveSession        = lazyPage(() => import('@/features/inventory/ActiveSession'))
const LabelDesigner        = lazyPage(() => import('@/features/labels/LabelDesigner'))
const OrdersPage           = lazyPage(() => import('@/features/orders/OrdersPage'))
const NeedsActionPage      = lazyPage(() => import('@/features/orders/NeedsActionPage'))
const OrderFormPage        = lazyPage(() => import('@/features/orders/OrderFormPage'))
const OrderDetailPage      = lazyPage(() => import('@/features/orders/OrderDetailPage'))
const QuickDraftPage       = lazyPage(() => import('@/features/quotes/QuickDraftPage'))
const CashflowPage         = lazyPage(() => import('@/features/cashflow/CashflowPage'))
const ReservesList         = lazyPage(() => import('@/features/inventory/ReservesList'))
const SupplierPOsPage      = lazyPage(() => import('@/features/suppliers/SupplierPOsPage'))
const WarehousePicking     = lazyPage(() => import('@/features/inventory/WarehousePicking'))
const WarehouseMovementPage = lazyPage(() => import('@/features/inventory/WarehouseMovementPage'))
const InboxPage             = lazyPage(() => import('@/features/notifications/InboxPage'))
const AutoPurchasePage      = lazyPage(() => import('@/features/autoPurchase/AutoPurchasePage'))
const AuditLogPage          = lazyPage(() => import('@/features/admin/AuditLogPage'))
const TemplateEditor        = lazyPage(() => import('@/features/notifications/TemplateEditor'))

const OFFICE_ROLES = ['owner', 'admin', 'manager']
const ADMIN_ROLES = ['owner', 'admin']
const WAREHOUSE_ROLES = ['owner', 'admin', 'storekeeper']
const INVENTORY_COUNTER_ROLES = ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer']
const CATALOG_EDITOR_ROLES = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']
const SUPPLIER_ROLES = ['owner', 'admin', 'manager', 'storekeeper']
const RECEIVING_ROLES = ['owner', 'admin', 'manager', 'cashier', 'storekeeper']
const REPORT_ROLES = ['owner', 'admin', 'manager', 'cashier']
const AiAssistantPage       = lazyPage(() => import('@/features/ai/AiAssistantPage'))

function AnalyticsHome() {
  const role = (useAuthStore((state) => state.session)?.user?.app_metadata?.role as string | undefined) ?? ''
  return <Navigate to={role === 'cashier' ? '/analytics/sales' : '/analytics/statistics'} replace />
}

function Loader() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-gray-400 text-sm">Завантаження...</div>
    </div>
  )
}

const ROUTE_RELOAD_KEY = 'forsage:web-route-reload-attempted'

function isRouteChunkError(error: unknown): boolean {
  const message = String((error as Error | null)?.message ?? error ?? '')
  const name = String((error as Error | null)?.name ?? '')
  return /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed|Failed to fetch/i.test(`${name} ${message}`)
}

type AppErrorBoundaryState = { error: Error | null }

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isRouteChunkError(error) && typeof window !== 'undefined') {
      const alreadyTried = window.sessionStorage.getItem(ROUTE_RELOAD_KEY) === '1'
      if (!alreadyTried) {
        window.sessionStorage.setItem(ROUTE_RELOAD_KEY, '1')
        window.location.reload()
        return
      }
    }
    console.error('[App] route render error', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm text-center">
          <div className="text-lg font-semibold text-gray-900">Не вдалося відкрити розділ</div>
          <p className="mt-2 text-sm text-gray-600">
            Сторінка завантажилась неповністю. Натисніть оновити — програма відкриє актуальну версію без білого екрана.
          </p>
          <button
            type="button"
            className="mt-4 rounded-xl bg-yellow-400 px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-yellow-300"
            onClick={() => {
              window.sessionStorage.removeItem(ROUTE_RELOAD_KEY)
              window.location.reload()
            }}
          >
            Оновити сторінку
          </button>
        </div>
      </div>
    )
  }
}

function App() {
  const desktop = isDesktopRuntime()
  const Router = desktop ? HashRouter : BrowserRouter

  // Після успішного запуску знову дозволяємо одноразове автоматичне
  // відновлення. Інакше один давній збій чанка блокував самовідновлення всіх
  // наступних переходів до закриття вкладки.
  useEffect(() => {
    const timer = window.setTimeout(() => window.sessionStorage.removeItem(ROUTE_RELOAD_KEY), 15_000)
    return () => window.clearTimeout(timer)
  }, [])


  // Захист від випадкової зміни числа колесом миші: якщо курсор над сфокусованим
  // числовим полем і крутиш колесо — браузер міняє значення. У касі/ревізії це
  // небезпечно (тихо міняється кількість/ціна). Знімаємо фокус — колесо гортає сторінку.
  useEffect(() => {
    const onWheel = () => {
      const el = document.activeElement as HTMLInputElement | null
      if (el && el.tagName === 'INPUT' && el.type === 'number') el.blur()
    }
    document.addEventListener('wheel', onWheel, { passive: true })
    return () => document.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <Router>
      <LocalSyncAgent />
      <AppErrorBoundary>
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route path="/analytics"            element={<AnalyticsHome />} />
          <Route path="/analytics/statistics" element={<ProtectedRoute roles={OFFICE_ROLES}><DashboardPage /></ProtectedRoute>} />
          <Route path="/analytics/sales"      element={<ProtectedRoute roles={REPORT_ROLES}><DailyReport /></ProtectedRoute>} />
          <Route path="/analytics/payroll"    element={<ProtectedRoute roles={ADMIN_ROLES}><PayrollPage /></ProtectedRoute>} />
          <Route path="/dashboard"             element={<Navigate to="/analytics/statistics" replace />} />
          <Route path="/products"           element={<ProtectedRoute><ProductsPage /></ProtectedRoute>} />
          <Route path="/products/new"       element={<TillOnly what="Створення товару"><ProtectedRoute roles={CATALOG_EDITOR_ROLES}><ProductFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/products/:id"       element={<ProtectedRoute><ProductDetailPage /></ProtectedRoute>} />
          <Route path="/products/:id/edit"  element={<TillOnly what="Редагування товару"><ProtectedRoute roles={CATALOG_EDITOR_ROLES}><ProductFormPage /></ProtectedRoute></TillOnly>} />

          <Route path="/customers"           element={<ProtectedRoute><CustomersPage /></ProtectedRoute>} />
          <Route path="/customers/new"       element={<TillOnly what="Створення клієнта"><ProtectedRoute><CustomerFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/customers/:id"       element={<ProtectedRoute><CustomerDetailPage /></ProtectedRoute>} />
          <Route path="/customers/:id/edit"  element={<TillOnly what="Редагування клієнта"><ProtectedRoute roles={OFFICE_ROLES}><CustomerFormPage /></ProtectedRoute></TillOnly>} />

          <Route path="/pos"      element={<TillOnly what="Каса"><ProtectedRoute><POSPage /></ProtectedRoute></TillOnly>} />
          <Route path="/sales"     element={<ProtectedRoute><SalesPage /></ProtectedRoute>} />
          <Route path="/returns"  element={<TillOnly what="Повернення"><ProtectedRoute><ReturnForm /></ProtectedRoute></TillOnly>} />
          <Route path="/cashflow" element={<ProtectedRoute><CashflowPage /></ProtectedRoute>} />
          <Route path="/reports"  element={<Navigate to="/analytics/sales" replace />} />
          <Route path="/abc"        element={<ProtectedRoute roles={ADMIN_ROLES}><ABCAnalysis /></ProtectedRoute>} />
          <Route path="/waitlist"   element={<ProtectedRoute roles={OFFICE_ROLES}><WaitlistPage /></ProtectedRoute>} />
          <Route path="/needs-action" element={<ProtectedRoute roles={OFFICE_ROLES}><NeedsActionPage /></ProtectedRoute>} />
          <Route path="/staff-analytics" element={<ProtectedRoute roles={ADMIN_ROLES}><StaffAnalytics /></ProtectedRoute>} />
          <Route path="/admin"    element={<ProtectedRoute roles={ADMIN_ROLES}><AdminPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute roles={ADMIN_ROLES}><SettingsPage /></ProtectedRoute>} />
          <Route path="/settings/draft-nomenclature" element={<ProtectedRoute roles={ADMIN_ROLES}><SupplierPricesPage /></ProtectedRoute>} />
          <Route path="/settings/draft-nomenclature/import" element={<TillOnly what="Імпорт номенклатури"><ProtectedRoute roles={ADMIN_ROLES}><BulkImportPage /></ProtectedRoute></TillOnly>} />
          
          <Route path="/suppliers" element={<ProtectedRoute roles={SUPPLIER_ROLES}><SuppliersPage /></ProtectedRoute>} />
          <Route path="/suppliers/new" element={<TillOnly what="Створення постачальника"><ProtectedRoute roles={OFFICE_ROLES}><SupplierFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/suppliers/:id" element={<ProtectedRoute roles={SUPPLIER_ROLES}><SupplierDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/:id/edit" element={<TillOnly what="Редагування постачальника"><ProtectedRoute roles={OFFICE_ROLES}><SupplierFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/receiving" element={<TillOnly what="Приймання товару"><ProtectedRoute roles={RECEIVING_ROLES}><ReceivingPage /></ProtectedRoute></TillOnly>} />
          <Route path="/receiving/ai" element={<TillOnly what="Приймання товару"><ProtectedRoute roles={RECEIVING_ROLES}><AiAssistantPage invoiceOnly /></ProtectedRoute></TillOnly>} />
          <Route path="/suppliers/invoices" element={<ProtectedRoute roles={RECEIVING_ROLES}><InvoicesPage /></ProtectedRoute>} />
          <Route path="/suppliers/pos" element={<ProtectedRoute roles={OFFICE_ROLES}><SupplierPOsPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/new" element={<TillOnly what="Прихідна накладна"><ProtectedRoute roles={RECEIVING_ROLES}><InvoiceFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/suppliers/invoices/:id" element={<ProtectedRoute roles={RECEIVING_ROLES}><InvoiceDetailPage /></ProtectedRoute>} />
          <Route path="/suppliers/invoices/:id/edit" element={<TillOnly what="Редагування накладної"><ProtectedRoute roles={RECEIVING_ROLES}><InvoiceFormPage /></ProtectedRoute></TillOnly>} />

          <Route path="/staff"          element={<ProtectedRoute roles={ADMIN_ROLES}><StaffPage /></ProtectedRoute>} />
          
          <Route path="/internal"       element={<ProtectedRoute roles={OFFICE_ROLES}><InternalConsumptionsPage /></ProtectedRoute>} />
          <Route path="/settings/channels" element={<ProtectedRoute roles={ADMIN_ROLES}><SettingsChannels /></ProtectedRoute>} />
          <Route path="/labels"  element={<ProtectedRoute roles={ADMIN_ROLES}><LabelDesigner /></ProtectedRoute>} />
          <Route path="/auto-purchase"   element={<ProtectedRoute roles={OFFICE_ROLES}><AutoPurchasePage /></ProtectedRoute>} />
          <Route path="/audit"           element={<ProtectedRoute roles={ADMIN_ROLES}><AuditLogPage /></ProtectedRoute>} />
          <Route path="/settings/templates" element={<ProtectedRoute roles={ADMIN_ROLES}><TemplateEditor /></ProtectedRoute>} />
          <Route path="/notifications"  element={<ProtectedRoute roles={OFFICE_ROLES}><InboxPage /></ProtectedRoute>} />
          <Route path="/ai-assistant"   element={<ProtectedRoute roles={OFFICE_ROLES}><AiAssistantPage /></ProtectedRoute>} />

          <Route path="/inventory"               element={<ProtectedRoute roles={INVENTORY_COUNTER_ROLES}><InventoryPage /></ProtectedRoute>} />
          <Route path="/inventory/picking"       element={<TillOnly what="Збірка замовлень"><ProtectedRoute roles={['owner', 'admin', 'manager', 'storekeeper']}><WarehousePicking /></ProtectedRoute></TillOnly>} />
          <Route path="/inventory/:id"          element={<TillOnly what="Ревізія"><ProtectedRoute roles={INVENTORY_COUNTER_ROLES}><ActiveSession /></ProtectedRoute></TillOnly>} />
          <Route path="/inventory/reserves"      element={<ProtectedRoute roles={['owner', 'admin', 'manager', 'storekeeper']}><ReservesList /></ProtectedRoute>} />
          <Route path="/inventory/movements"     element={<TillOnly what="Переміщення складу"><ProtectedRoute roles={WAREHOUSE_ROLES}><WarehouseMovementPage /></ProtectedRoute></TillOnly>} />
          <Route path="/inventory/writeoffs"     element={<ProtectedRoute roles={WAREHOUSE_ROLES}><WriteoffsPage /></ProtectedRoute>} />
          <Route path="/inventory/writeoffs/new" element={<TillOnly what="Списання"><ProtectedRoute roles={WAREHOUSE_ROLES}><WriteoffFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/inventory/writeoffs/:id" element={<ProtectedRoute roles={WAREHOUSE_ROLES}><WriteoffDetailPage /></ProtectedRoute>} />

          {/* Чат-боти — окремий розділ (той самий компонент у режимі chatMode) */}
          <Route path="/chats" element={<ProtectedRoute roles={OFFICE_ROLES}><OrdersPage /></ProtectedRoute>} />
          <Route path="/orders"          element={<ProtectedRoute roles={OFFICE_ROLES}><OrdersPage /></ProtectedRoute>} />
          <Route path="/orders/new"      element={<TillOnly what="Створення замовлення"><ProtectedRoute roles={OFFICE_ROLES}><OrderFormPage /></ProtectedRoute></TillOnly>} />
          <Route path="/orders/:id"      element={<ProtectedRoute roles={OFFICE_ROLES}><OrderDetailPage /></ProtectedRoute>} />
          <Route path="/orders/:id/edit" element={<TillOnly what="Редагування замовлення"><ProtectedRoute roles={OFFICE_ROLES}><OrderFormPage /></ProtectedRoute></TillOnly>} />

          <Route path="/quotes"          element={<Navigate to="/orders" replace />} />
          <Route path="/quotes/new"      element={<TillOnly what="Створення прорахунку"><ProtectedRoute roles={OFFICE_ROLES}><QuickDraftPage /></ProtectedRoute></TillOnly>} />
          <Route path="/quotes/:id"      element={<ProtectedRoute roles={OFFICE_ROLES}><QuickDraftPage /></ProtectedRoute>} />

          <Route path="/" element={<Navigate to="/analytics" replace />} />
          <Route path="*" element={<Navigate to="/analytics" replace />} />
        </Routes>
      </Suspense>
      </AppErrorBoundary>
      <ToastContainer />
      <CommandPalette />
    </Router>
  )
}

export default App

