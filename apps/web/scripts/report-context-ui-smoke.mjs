// Real report/payroll views, synthetic read services, isolated browser, localhost only.
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
  '@/features/analytics/AnalyticsLayout': 'export function AnalyticsLayout({children,title}){return <main style={{padding:12,minWidth:0}}><h1>{title}</h1>{children}</main>}',
  '@/stores/authStore': 'import{useSyncExternalStore}from"react";export const useAuthStore=Object.assign(fn=>{useSyncExternalStore(cb=>{fixture.listeners.add(cb);return()=>fixture.listeners.delete(cb)},()=>fixture.user);return fn({session:{user:{id:fixture.user,app_metadata:{role:"owner"}}}})},{getState:()=>({})})',
  '@/lib/desktopBridge': 'export const isDesktopRuntime=()=>false;export const desktopBridge=()=>null',
  '@/features/staff/staffApi': 'export const staffApi=fixture.staff',
  '@/features/admin/adminApi': 'export const ROLE_LABELS={tire_worker:"Шиномонтажник"};export const adminApi={listUsers:async()=>({data:fixture.workers})}',
  '@/features/pos/shiftApi': 'export const shiftApi={current:()=>{throw Error("No writes allowed")}}',
  '@/features/reports/reportApi': 'export const reportApi=fixture.reportApi',
  '@/lib/api': 'export const api={get:async url=>{fixture.staffReads.push(url);return{data:[]}}}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.toasts.push(m),success:m=>fixture.toasts.push(m)};export function ToastContainer(){return null}',
}
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useNavigate}from'react-router-dom';import Daily from'@/features/reports/DailyReport';import Payroll from'@/features/analytics/PayrollPage';import Staff from'@/features/analytics/StaffAnalytics';import'@/index.css';function App(){const navigate=useNavigate();fixture.navigate=navigate;return <Routes><Route path='/analytics/sales' element={<Daily/>}/><Route path='/analytics/payroll' element={<Payroll/>}/><Route path='/analytics/staff' element={<Staff/>}/><Route path='/away' element={<p>Away</p>}/></Routes>}createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[fixture.start]}><App/></MemoryRouter>)`
const bootstrap = `
window.fixture={start:window.testStart||'/analytics/sales',user:'owner-a',listeners:new Set(),reads:[],staffReads:[],toasts:[],count:100};
fixture.workers=[{id:'worker',full_name:'Андрій',role:'tire_worker',is_active:true},{id:'worker2',full_name:'Петро',role:'tire_worker',is_active:true}];
fixture.sold={product_id:'product',sku:'FILTER',barcode:'200000000001',name:'Фільтр тестовий',unit:'шт',qty_sold:1,qty_returned:0,qty_net:1,revenue:10000,refund_total:0,net_revenue:10000,qty_on_hand:3,storage_bin:null,suppliers:[{id:'supplier',name:'Постачальник тест'}],sellers:[{id:'seller',name:'Касир тест',qty_sold:1,qty_returned:0,qty_net:1,revenue:10000,refund_total:0,net_revenue:10000}]};
fixture.reportApi={soldItems:async(from,to)=>{fixture.reads.push({kind:'sold',from,to});return{data:[fixture.sold]}},salesPeriod:async(from,to)=>({data:{total_sales:0,total_revenue:0,net_revenue:0,returns_count:0,returns_total:0,profit:0,daily:[],sales:[],by_method:{cash:0,card:0,transfer:0,account:0,debt:0},payment_received_total:0}})};
fixture.staff={summary:async period=>{fixture.reads.push({kind:'salary',period});return{data:[]}},dailySummary:async()=>({data:[]}),listSalary:async()=>({data:[{id:'salary-work',employee_id:'worker',amount:2600,type:'advance',method:'cash',period:'2026-09',created_at:'2026-10-01T08:00:00Z',work_date:'2026-09-30',note:'Інший касир прийняв наступного дня'}]}),tireServiceReport:async date=>{fixture.reads.push({kind:'tire',date});const workers=fixture.workers.map(worker=>({employee_id:worker.id,employee_name:worker.full_name,services_qty:fixture.count,service_revenue:36000*fixture.count,commission_earned:12600,daily_rate:0,earned:12600,paid:10000,penalty:0,balance:2600,due:2600,cash_revenue:36000,cash_register_received:36000,cash_handed_over:0,cash_pending:0,salary_available_on:'2026-10-02',salary_ready:true,payable_due:2600}));return{date,details_version:1,data:workers,receipts:workers.flatMap(worker=>Array.from({length:fixture.count},(_,i)=>({id:worker.employee_id+'-'+i,sale_number:worker.employee_id+'-'+i,employee_id:worker.employee_id,completed_at:date+'T13:00:00Z',cashier_name:'Касир вечірньої зміни',notes:'Робота ввечері',payment_method:'cash',service_revenue:36000,services:[{id:'line-'+i,description:'Балансування',qty:1,unit_price:36000,total:36000}]}))),salary_operations:Array.from({length:100},(_,i)=>({id:'op-'+i,employee_id:'worker',type:'bonus',source:'commission',amount:126,method:'cash',work_date:date,created_at:date+'T20:00:00Z',note:'Нарахування '+i,cashier_name:'Інший касир'})),cash_handovers:[],totals:{}}}};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', optimizeDeps: { entries: [] }, esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
  name: 'report-context-fixture', enforce: 'pre', resolveId(id) { if (id === 'virtual:report-context.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:report-context.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(vite) { vite.middlewares.use('/report-context-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/report-context-test', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:report-context.tsx"></script></body></html>')) }) },
}] })
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  await page.goto(base + 'report-context-test')
  const navigate = async to => { await page.evaluate(to => fixture.navigate(to), to) }
  const leave = async () => { await navigate('/away'); await page.getByText('Away', { exact: true }).waitFor() }
  await page.getByRole('button', { name: 'Продані товари', exact: true }).click()
  await page.getByLabel('Від', { exact: true }).fill('2026-09-01')
  await page.getByLabel('До', { exact: true }).fill('2026-09-30')
  await page.getByLabel('Продавець', { exact: true }).selectOption('seller')
  await page.getByLabel('Постачальник для дозамовлення').selectOption('supplier')
  await page.getByPlaceholder('Назва, артикул або штрихкод').fill('FILTER')
  await leave(); await navigate('/analytics/sales')
  await page.getByRole('heading', { name: 'Продані товари за період' }).waitFor()
  assert.equal(await page.getByLabel('Від', { exact: true }).inputValue(), '2026-09-01')
  assert.equal(await page.getByLabel('До', { exact: true }).inputValue(), '2026-09-30')
  assert.equal(await page.getByLabel('Продавець', { exact: true }).inputValue(), 'seller')
  assert.equal(await page.getByLabel('Постачальник для дозамовлення').inputValue(), 'supplier')
  assert.equal(await page.getByPlaceholder('Назва, артикул або штрихкод').inputValue(), 'FILTER')
  await page.evaluate(() => { fixture.user = 'owner-b'; fixture.listeners.forEach(listener => listener()) })
  await page.getByRole('button', { name: 'Продані товари', exact: true }).click()
  assert.equal(await page.getByPlaceholder('Назва, артикул або штрихкод').inputValue(), '')
  assert.equal(await page.getByLabel('Продавець', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('Постачальник для дозамовлення').inputValue(), '')
  assert.notEqual(await page.getByLabel('Від', { exact: true }).inputValue(), '2026-09-01')
  await page.evaluate(() => { fixture.user = 'owner-a'; fixture.listeners.forEach(listener => listener()) })
  assert.equal(await page.getByPlaceholder('Назва, артикул або штрихкод').inputValue(), 'FILTER')
  await navigate('/analytics/staff')
  await page.getByRole('button', { name: 'Інший період' }).click()
  const staffDates = page.locator('input[type=date]')
  await staffDates.nth(0).fill('2026-08-01'); await staffDates.nth(1).fill('2026-08-31')
  await leave(); await navigate('/analytics/staff')
  assert.equal(await staffDates.nth(0).inputValue(), '2026-08-01'); assert.equal(await staffDates.nth(1).inputValue(), '2026-08-31')
  await page.evaluate(() => { fixture.user = 'owner-b'; fixture.listeners.forEach(listener => listener()) })
  assert.equal(await staffDates.count(), 0, 'another user does not inherit a custom staff range')
  await page.evaluate(() => { fixture.user = 'owner-a'; fixture.listeners.forEach(listener => listener()) })
  assert.equal(await staffDates.nth(0).inputValue(), '2026-08-01')
  await navigate('/analytics/payroll')
  await page.getByLabel('Місяць зарплати').fill('2026-09')
  await page.getByRole('button', { name: 'Операції', exact: true }).first().click()
  await page.getByRole('link', { name: /Роботи, чеки та розрахунок зарплати/ }).click()
  await page.getByText('Період зарплати: 2026-09.', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('Дата робіт шиномонтажу').inputValue(), '')
  assert.equal(await page.getByLabel('Працівник шиномонтажу').inputValue(), 'worker')
  assert.deepEqual(await page.evaluate(() => fixture.reads.filter(row => row.kind === 'tire')), [], 'month-only entry must not load today or stale day')
  await page.getByLabel('Дата робіт шиномонтажу').fill('2026-09-30')
  const worker = page.getByRole('article', { name: 'Роботи та зарплата: Андрій' })
  await worker.waitFor()
  assert.equal(await worker.getByRole('region', { name: /^Чек / }).count(), 50)
  await worker.getByRole('button', { name: 'Ще чеки (50)' }).click()
  assert.equal(await worker.getByRole('region', { name: /^Чек / }).count(), 100)
  await worker.getByRole('button', { name: 'Ще операції (50)' }).click()
  assert.equal(await worker.locator('ol > li').count(), 100)
  assert.equal(await page.getByRole('button', { name: 'Виплатити з каси' }).count(), 0, 'web remains read-only')
  for (const scale of [1.25, 1.5]) {
    await page.setViewportSize({ width: Math.floor(1440 / scale), height: Math.floor(1000 / scale) })
    await page.evaluate(() => window.scrollTo(0, 0))
    const box = await worker.getByLabel('Короткий підсумок зарплати: Андрій').boundingBox()
    assert(box && box.y >= 0 && box.y + box.height < Math.floor(1000 / scale), 'summary visible before long receipt list at effective zoom ' + scale)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  for (const scale of [1.25, 1.5]) {
    await page.evaluate(scale => { document.documentElement.style.zoom = String(scale); window.scrollTo(0, 0) }, scale)
    const box = await worker.getByLabel('Короткий підсумок зарплати: Андрій').boundingBox()
    assert(box && box.y + box.height < 1000, 'summary visible with actual CSS text/layout zoom ' + scale)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1' })
  for (const count of [1, 50]) {
    await page.evaluate(count => { fixture.count = count }, count)
    await page.getByRole('button', { name: 'Оновити', exact: true }).click(); await worker.waitFor()
    assert.equal(await worker.getByRole('region', { name: /^Чек / }).count(), count)
    await page.getByLabel('Працівник шиномонтажу').selectOption('worker2')
    const other = page.getByRole('article', { name: 'Роботи та зарплата: Петро' })
    await other.waitFor(); assert.equal(await other.getByRole('region', { name: /^Чек / }).count(), count)
    await page.getByLabel('Працівник шиномонтажу').selectOption('worker')
  }
  await navigate(-1)
  assert.equal(await page.getByLabel('Місяць зарплати').inputValue(), '2026-09')
  await page.getByRole('button', { name: 'Операції', exact: true }).first().click()
  await page.getByRole('link', { name: 'День робіт: 2026-09-30' }).click()
  await worker.waitFor()
  assert.equal(await page.getByLabel('Дата робіт шиномонтажу').inputValue(), '2026-09-30', 'work date retained even though payment posted October 1')
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: per-user sold/staff filters survive navigation; payroll month explicit with no fabricated day; work-date links; return month; 1/50/100 receipts, 100 operations, two workers, effective 125/150% viewport, one read-only summary without duplicate payouts. UI fixture only, not database completeness evidence.')
} finally { await browser?.close(); await server.close() }
