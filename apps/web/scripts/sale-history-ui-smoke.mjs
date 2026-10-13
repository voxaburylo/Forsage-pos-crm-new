// Actual list/report/detail pages, synthetic read services, isolated browser and localhost only.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/components/Layout': 'export function Layout({children,title}){return <main style={{padding:12,minWidth:0}}><h1>{title}</h1>{children}</main>}',
  '@/features/analytics/AnalyticsLayout': 'export function AnalyticsLayout({children,title}){return <main style={{padding:12,minWidth:0}}><h1>{title}</h1>{children}</main>}',
  '@/stores/authStore': 'import{useSyncExternalStore}from"react";export const useAuthStore=Object.assign((fn=x=>x)=>{useSyncExternalStore(cb=>{fixture.listeners.add(cb);return()=>fixture.listeners.delete(cb)},()=>fixture.user);return fn({session:{user:{id:fixture.user,app_metadata:{role:"owner"}}}})},{getState:()=>({})})',
  '@/lib/desktopBridge': 'export const isDesktopRuntime=()=>false;export const desktopBridge=()=>null',
  '@/features/pos/saleApi': 'export const saleApi=fixture.sales',
  '@/features/pos/ReceiptPrint': 'export const printReceipt=()=>{throw Error("Unexpected printing")};export function ReceiptPrint(){return null}',
  '@/features/orders/orderApi': 'export const orderApi=fixture.orders',
  '@/features/customers/customerApi': 'export const customerApi={list:async()=>({data:[]})}',
  '@/features/customers/customerVehiclesApi': 'export const customerVehiclesApi={list:async()=>({data:[]})}',
  '@/features/products/productApi': 'export const productApi={search:async()=>({data:[]})};export function requestDesktopSync(){throw Error("No sync writes")}',
  '@/features/staff/staffApi': 'export const staffApi={}',
  '@/features/admin/adminApi': 'export const ROLE_LABELS={};export const adminApi={listUsers:async()=>({data:[]})}',
  '@/features/pos/shiftApi': 'export const shiftApi={current:()=>{throw Error("No writes allowed")}}',
  '@/features/reports/reportApi': 'export const reportApi=fixture.reportApi',
  '@/lib/api': 'export const api={get:async()=>({data:[]}),post:()=>{throw Error("No writes")},patch:()=>{throw Error("No writes")}}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.toasts.push(m),warning:m=>fixture.toasts.push(m),success:m=>fixture.toasts.push(m)};export function ToastContainer(){return null}',
}
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useNavigate}from'react-router-dom';import Daily from'@/features/reports/DailyReport';import Sales from'@/features/sales/SalesPage';import Orders from'@/features/orders/OrdersPage';import{SearchInput}from'@/components/ui/SearchInput';import'@/index.css';function InputTest(){const[a,setA]=React.useState(''),[b,setB]=React.useState('');return <><SearchInput placeholder='Default delay' value={a} onChange={v=>{fixture.inputEvents.push({mode:'default',value:v});setA(v)}}/><SearchInput placeholder='Immediate mode' value={b} debounceMs={0} onChange={v=>{fixture.inputEvents.push({mode:'sync',value:v});setB(v)}}/></>}function App(){const navigate=useNavigate();fixture.navigate=navigate;return <Routes><Route path='/analytics/sales' element={<Daily/>}/><Route path='/sales' element={<Sales/>}/><Route path='/orders' element={<Orders/>}/><Route path='/inputs' element={<InputTest/>}/><Route path='/away' element={<p>Away</p>}/></Routes>}createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/sales']}><App/></MemoryRouter>)`
const bootstrap = `
window.fixture={user:'owner-a',listeners:new Set(),reads:[],pending:[],toasts:[],inputEvents:[],failed:true,shrink:false};
fixture.sale=page=>({id:'receipt-'+page,sale_number:'R-'+page,status:'completed',payment_method:'cash',total:179500,completed_at:'2026-10-04T10:00:00Z',created_at:'2026-10-04T10:00:00Z',sale_items:[{id:'line',product_id:'product',product:{name:'Помпа Hort'},qty:1,unit_price:62500,total:62500}],cashier:{id:'cashier',full_name:'Касир',is_active:true}});
fixture.sales={get:async id=>{fixture.reads.push({kind:'detail',id});return{data:fixture.sale(id.split('-')[1])}},list:async params=>{fixture.reads.push({kind:'sales',...params});if(params.product_search==='FAIL'&&fixture.failed)throw Error('Temporary read failure');if(params.product_search==='OLD')return new Promise((resolve,reject)=>fixture.pending.push({resolve,reject}));const pages=fixture.shrink?1:4;return{filter_version:1,data:params.page>pages?[]:[fixture.sale(params.page)],pagination:{total:fixture.shrink?1:61,total_pages:pages}}}};
fixture.orders={list:async(offset,opts,limit,filters)=>{fixture.reads.push({kind:'orders',offset,limit,...filters});return{data:offset>=150?[]:[{id:'order-'+offset,order_number:offset+1,status:'new',source:'walk_in',total_amount:10000,total_paid:0,prepayment:0,created_at:'2026-10-13T08:00:00Z',updated_at:'r1',customer:{id:'customer',full_name:'Клієнт',phone:'+380671234567'},items:[{id:'item',name:'Позиція '+offset,qty:1,sell_price:10000,item_status:'pending',source_type:'supplier'}]}],meta:{has_more:offset<100}}}};
fixture.sold={product_id:'product',sku:'FILTER',barcode:'200000000001',name:'Фільтр тестовий',unit:'шт',qty_sold:1,qty_returned:1,qty_net:0,revenue:10000,refund_total:10000,net_revenue:0,qty_on_hand:3,storage_bin:null,suppliers:[{id:'supplier',name:'Постачальник тест'}],sellers:[{id:'seller',name:'Касир тест',qty_sold:1,qty_returned:1,qty_net:0,revenue:10000,refund_total:10000,net_revenue:0}]};
fixture.reportApi={soldItems:async()=>({data:[fixture.sold]}),salesPeriod:async()=>({data:{total_sales:0,total_revenue:0,net_revenue:0,returns_count:0,returns_total:0,profit:0,daily:[],sales:[],by_method:{cash:0,card:0,transfer:0,account:0,debt:0},payment_received_total:0}})};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', optimizeDeps: { entries: [] }, esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
  name: 'sale-history-fixture', enforce: 'pre', resolveId(id) { if (id === 'virtual:sale-history.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:sale-history.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(vite) { vite.middlewares.use('/sale-history-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/sale-history-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:sale-history.tsx"></script></body></html>')) }) },
}] })
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000)
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  await page.goto(base + 'sale-history-test')
  const navigate = to => page.evaluate(to => fixture.navigate(to), to)
  const pageInput = () => page.getByLabel('Номер сторінки').filter({ visible: true })
  const productInput = () => page.getByLabel('Товар, артикул або штрихкод')
  const waitSale = n => page.getByRole('button', { name: '#R-' + n, exact: true }).waitFor()
  await waitSale(1)
  await navigate('/inputs'); await page.getByPlaceholder('Immediate mode').waitFor()
  const immediateEvents = await page.evaluate(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    for (const placeholder of ['Default delay', 'Immediate mode']) {
      const input = document.querySelector('input[placeholder="' + placeholder + '"]')
      set.call(input, 'test'); input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return fixture.inputEvents
  })
  assert.deepEqual(immediateEvents, [{ mode: 'sync', value: 'test' }], 'explicit zero mode is synchronous while the default remains delayed')
  await page.waitForFunction(() => fixture.inputEvents.length === 2)
  assert.deepEqual(await page.evaluate(() => fixture.inputEvents[1]), { mode: 'default', value: 'test' })
  await navigate('/sales'); await waitSale(1)
  await pageInput().fill('3'); await pageInput().press('Enter'); await waitSale(3)
  await page.getByRole('button', { name: '#R-3', exact: true }).click(); await page.getByRole('heading', { name: 'Чек #R-3' }).waitFor()
  await page.getByRole('button', { name: 'Закрити', exact: true }).last().click(); assert.equal(await pageInput().inputValue(), '3')
  await navigate('/away'); await page.getByText('Away').waitFor(); await navigate('/sales'); await waitSale(3)
  const readsBeforeTyping = await page.evaluate(() => fixture.reads.filter(row => row.kind === 'sales').length)
  await productInput().pressSequentially('Фільтр', { delay: 10 })
  await page.waitForFunction(() => fixture.reads.filter(row => row.kind === 'sales').at(-1).product_search === 'Фільтр')
  assert.equal(await page.evaluate(() => fixture.reads.filter(row => row.kind === 'sales').length), readsBeforeTyping + 1, 'rapid product typing issues only the final request')
  const priceReads = await page.evaluate(() => fixture.reads.filter(row => row.kind === 'sales').length)
  await page.getByLabel('Ціна одиниці в чеку, ₴').pressSequentially('1170', { delay: 10 })
  await page.waitForFunction(() => fixture.reads.filter(row => row.kind === 'sales').at(-1).unit_price === 117000)
  assert.equal(await page.evaluate(() => fixture.reads.filter(row => row.kind === 'sales').length), priceReads + 1, 'rapid historic-price typing issues only the final request')
  const generalReads = await page.evaluate(() => fixture.reads.filter(row => row.kind === 'sales').length)
  await page.getByPlaceholder('Чек, клієнт, VIN або товар…').pressSequentially('Номер', { delay: 10 })
  await page.waitForFunction(() => fixture.reads.filter(row => row.kind === 'sales').at(-1).search === 'Номер')
  assert.equal(await page.evaluate(() => fixture.reads.filter(row => row.kind === 'sales').length), generalReads + 1, 'general text has one debounce, not a read on each letter')
  await productInput().fill('Помпа'); await waitSale(1)
  await page.getByLabel('Ціна одиниці в чеку, ₴').fill('625'); await page.getByLabel('Продаж від', { exact: true }).fill('2026-10-04'); await page.getByLabel('Продаж до', { exact: true }).fill('2026-10-04')
  await page.waitForFunction(() => fixture.reads.some(row => row.unit_price === 62500 && row.date_to_exclusive === '2026-10-04T21:00:00.000Z' && !row.date_to))
  await productInput().fill('FAIL'); await page.getByRole('alert').filter({ hasText: 'Temporary read failure' }).waitFor()
  assert.equal(await page.getByText('Продажів не знайдено', { exact: true }).count(), 0)
  await page.evaluate(() => fixture.failed = false); await page.getByRole('button', { name: 'Повторити', exact: true }).click(); await waitSale(1)
  assert.equal(await productInput().inputValue(), 'FAIL')
  await productInput().fill('OLD'); await page.waitForFunction(() => fixture.pending.length === 1)
  await productInput().fill('CURRENT')
  await page.evaluate(() => fixture.pending[0].reject(Error('Stale failure')))
  await waitSale(1)
  assert.equal(await page.getByRole('alert').count(), 0); assert.equal(await productInput().inputValue(), 'CURRENT')
  await productInput().fill('OLD'); await page.waitForFunction(() => fixture.pending.length === 2)
  await productInput().fill('CURRENT-2')
  await page.evaluate(() => fixture.pending[1].resolve({ data: [fixture.sale(9)], pagination: { total: 1, total_pages: 1 } }))
  await waitSale(1)
  assert.equal(await page.getByRole('button', { name: '#R-9', exact: true }).count(), 0)
  await page.evaluate(() => fixture.shrink = true); await pageInput().fill('3'); await pageInput().press('Enter'); await waitSale(1)
  await page.waitForFunction(() => fixture.reads.filter(row => row.kind === 'sales').at(-1).page === 1)
  await page.evaluate(() => fixture.shrink = false)

  await navigate('/orders'); await page.getByText('Позиція 0', { exact: false }).filter({ visible: true }).first().waitFor()
  await pageInput().fill('3'); await pageInput().press('Enter'); await page.waitForFunction(() => fixture.reads.filter(row => row.kind === 'orders').at(-1).offset === 100)
  await pageInput().fill('999'); await pageInput().press('Enter')
  await page.waitForFunction(() => fixture.reads.filter(row => row.kind === 'orders').some(row => row.offset === 49900) && fixture.reads.filter(row => row.kind === 'orders').at(-1).offset === 100)
  assert.equal(await pageInput().inputValue(), '3')
  await pageInput().fill('0'); await pageInput().press('Enter'); await page.waitForFunction(() => fixture.toasts.length > 0)
  await navigate('/away'); await page.getByText('Away').waitFor(); await navigate('/orders'); await pageInput().waitFor(); assert.equal(await pageInput().inputValue(), '3')

  await navigate('/analytics/sales'); await page.getByRole('button', { name: 'Продані товари', exact: true }).click()
  await page.getByLabel('Від', { exact: true }).fill('2026-09-01'); await page.getByLabel('До', { exact: true }).fill('2026-09-30')
  await page.getByLabel('Продавець', { exact: true }).selectOption('seller'); await page.getByLabel('Постачальник для дозамовлення').selectOption('supplier')
  await page.getByRole('button', { name: 'Фільтр тестовий', exact: true }).filter({ visible: true }).click(); await waitSale(1)
  await page.waitForFunction(() => fixture.reads.some(row => row.product_id === 'product' && row.seller_id === 'seller' && row.include_returns === '1' && row.date_from === '2026-08-31T21:00:00.000Z'))
  await page.getByText(/повні суми чеків, не підсумок товару/).waitFor()
  assert.equal(await page.getByLabel('Продавець зі звіту').inputValue(), 'seller')
  await pageInput().fill('3'); await pageInput().press('Enter'); await waitSale(3)
  await navigate('/away'); await page.getByText('Away').waitFor(); await navigate(-1); await waitSale(3)
  assert.equal(await pageInput().inputValue(), '3', 'a report link is not re-applied on back navigation over saved page state')
  await navigate(-1); await page.getByRole('heading', { name: 'Продані товари за період' }).waitFor()
  assert.equal(await page.getByLabel('Від', { exact: true }).inputValue(), '2026-09-01'); assert.equal(await page.getByLabel('Постачальник для дозамовлення').inputValue(), 'supplier')
  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByRole('button', { name: 'Фільтр тестовий', exact: true }).filter({ visible: true }).click(); await page.getByRole('button', { name: 'Відкрити чек #R-3' }).waitFor()
  for (const scale of [1, 1.25, 1.5]) {
    await page.evaluate(scale => document.body.style.zoom = String(scale), scale)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'filters stay within mobile width at zoom ' + scale)
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: actual sales/order pagination and empty-page recovery; shared receipt detail; persistent filters; historical price/date request; failure/retry and stale failure; report product/seller/return-date drilldown/back; mobile report links and 100/125/150% layout. Synthetic only; no printing or writes.')
} finally { await browser?.close(); await server.close() }
