import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { useWritesToMainPc, writesToMainPc } from '@/lib/mainPcData'
import { remoteBridgeSlot, setRemoteBridgeSlot, subscribeRemoteBridgeSlot } from '@/lib/remoteDesktop/slot'

// 23.11.2026, план 4.1 «веб через головний ПК — кожен екран»: екрани перегляду у вебі працюють повністю, коли головний ПК
// на зв'язку (усі зміни виконує він), а без ПК — лише перегляд, як і раніше.
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
const app = read('../App.tsx')
const route = (path: string) => {
  const lines = app.split('\n').filter(line => line.includes(`<Route path="${path}"`))
  expect(lines, `маршрут ${path}`).toHaveLength(1)
  return lines[0]
}

describe('the bridge to the main PC is observable', () => {
  afterEach(() => setRemoteBridgeSlot(null))

  it('notifies screens when the bridge appears or goes, once per change', () => {
    const seen: unknown[] = []
    const stop = subscribeRemoteBridgeSlot(() => seen.push(remoteBridgeSlot()))
    const bridge = { catalog: {} }
    expect(writesToMainPc()).toBe(false)
    setRemoteBridgeSlot(bridge)
    setRemoteBridgeSlot(bridge)
    expect(writesToMainPc()).toBe(true)
    setRemoteBridgeSlot(null)
    stop()
    setRemoteBridgeSlot(bridge)
    expect(seen).toEqual([bridge, null])
  })

  it('the screen hook reads the same answer', () => {
    expect(typeof useWritesToMainPc).toBe('function')
    expect(read('../lib/mainPcData.ts')).toContain('useSyncExternalStore(subscribeRemoteBridgeSlot, writesToMainPc, () => false)')
  })
})

describe('screens that were view-only in the web now work through the main PC', () => {
  it('products, customers and recount', () => {
    for (const [path, screen] of [
      ['/products', 'ProductsPage'], ['/products/:id', 'ProductDetailPage'], ['/customers', 'CustomersPage'],
      ['/customers/:id', 'CustomerDetailPage'], ['/analytics/recount', 'NegativeStockPage'],
    ]) expect(route(path)).toContain(`<MainPcWhenOnline><${screen} /></MainPcWhenOnline>`)
  })

  it('orders: the full till screens through the main PC, the old web screens without it', () => {
    expect(route('/orders')).toContain('<MainPcWhenOnline view={<OrdersViewPage />}><OrdersPage /></MainPcWhenOnline>')
    expect(route('/orders/:id')).toContain('<MainPcWhenOnline view={<OrdersViewPage />}><OrderDetailPage /></MainPcWhenOnline>')
    expect(route('/orders/:id/add')).toContain('<MainPcWhenOnline view={<WebOrderAppendPage />}><OrderDetailPage /></MainPcWhenOnline>')
  })

  it('buttons follow the main PC link, not only the till program', () => {
    expect(read('../features/products/ProductsPage.tsx')).toContain("const canEditCatalog = mainPcWrites && ['owner', 'admin', 'manager', 'storekeeper'].includes(role)")
    const detail = read('../features/products/ProductDetailPage.tsx')
    expect(detail).toContain("const canWrite = mainPcWrites && ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role)")
    expect(detail).toContain('const canEditViaTill = !mainPcWrites && !offlineMode')
    // Гроші в касі (зарплата, виплата шиномонтажникам) — лише на самій касі (план вебу 22.11.2026).
    expect(route('/analytics/payroll')).not.toContain('MainPcWhenOnline')
    expect(route('/analytics/sales')).not.toContain('MainPcWhenOnline')
    expect(read('../features/analytics/PayrollPage.tsx')).toContain('const canWrite = isDesktopRuntime()')
    // Злиття карток ще не перенесено в базу каси — і через головний ПК його не обіцяємо.
    expect(read('../features/products/MergeModal.tsx')).toContain('const localMergeUnavailable = writesToMainPc()')
  })

  it('the wrapper: till program as is; web without the PC is view only; cashiers stay on view', () => {
    const wrapper = read('./TillOnly.tsx')
    const body = wrapper.slice(wrapper.indexOf('export function MainPcWhenOnline'), wrapper.indexOf('/** offline —'))
    expect(body).toContain('if (desktop) return <>{children}</>')
    expect(body).toContain('if (!allowed) return <>{view ?? children}</>')
    expect(body).toContain('<div key="view" data-main-pc-mode="view">{view ?? children}</div>')
    expect(body).toContain('<div key="main-pc" data-main-pc-mode="main-pc"><MainPcBadge state={state} />{children}</div>')
    expect(wrapper).toContain('const viaWeb = useWebWorkAccess()')
    expect(read('../lib/webWorkAccess.ts')).toContain("new Set(['owner', 'admin', 'manager'])")
  })
})

describe('money stays at the till even when the web works through the main PC', () => {
  it('order card: payment, issue, return and exchange buttons only in the till program', () => {
    const order = read('../features/orders/OrderDetailPage.tsx')
    expect(order).toContain('const atTill = isDesktopRuntime()')
    expect(order).toContain("canUseOrderCash(state.session?.user.app_metadata?.role)) && atTill")
    expect(order).toContain("{atTill && serverActionsReady && order.status === 'completed' && order.sale_id && (")
  })

  it('customer card: no «cash at the till» button in the web; server-only notes stay visible', () => {
    const customer = read('../features/customers/CustomerDetailPage.tsx')
    expect(customer).toContain('{isDesktopRuntime() && canUseOrderCash(role) && <Button')
    expect(customer).toContain('{!isDesktopRuntime() && !offlineMode && (')
  })
})
