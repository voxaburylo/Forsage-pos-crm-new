// Actual customer creation forms and receipt UI, isolated synthetic APIs only.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks = {
  '@/features/customers/customerApi': 'export const customerApi=fixture.customers',
  '@/features/customers/customerGroupsApi': 'export const customerGroupsApi={list:async()=>({data:[]})}',
  '@/features/admin/pricingApi': 'export const pricingApi={listTiers:async()=>({data:[{id:"tier",name:"СТО",discount_pct:10}]})}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({pos:{}});export const isDesktopRuntime=()=>true',
  '@/lib/offlineDB': 'export const searchCustomersOffline=async()=>[]',
  '@/lib/api': 'export const api={get:()=>{throw Error("Unexpected remote read")},post:()=>{throw Error("Unexpected remote write")}}',
  '@/stores/authStore': 'export const useAuthStore=select=>select(useAuthStore.getState());useAuthStore.getState=()=>({session:{user:{id:"synthetic-user",app_metadata:{role:fixture.role}}},offlineMode:false})',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.errors.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children,title,onBack,actions}){return <main id="app-main-scroll"><h1>{title}</h1>{onBack&&<button onClick={onBack}>Назад</button>}{actions}{children}</main>}',
}
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{createMemoryRouter,RouterProvider,Routes,Route,useLocation}from'react-router-dom';
import Customers from'/src/features/customers/CustomersPage.tsx';import Form from'/src/features/customers/CustomerFormPage.tsx';import{QuickCustomerModal}from'/src/features/customers/QuickCustomerModal.tsx';import{ReceiptPanel}from'/src/features/pos/ReceiptPanel.tsx';import{usePOSStore}from'/src/stores/posStore.ts';import{customerDiscountPct}from'/src/features/customers/customerDiscount.ts';import{NavigationGuard}from'/src/hooks/useUnsavedChanges.ts';import'/src/index.css';
const store=usePOSStore.getState();store.replaceOpenReceipts([]);store.setPriceRounding({enabled:false});store.addItem({productId:'synthetic-part',sku:'SYNTHETIC',name:'Контрольний товар',unit:'шт',qty:2,unitPrice:10000,discount:0,qtyOnHand:3});fixture.store=usePOSStore;
function PosCreation(){const[open,setOpen]=useState(true);return <div style={{height:700,maxWidth:700}}><ReceiptPanel onPay={()=>{throw Error('Unexpected checkout')}} onSelectCustomer={()=>setOpen(true)} onClear={()=>{throw Error('Unexpected basket reset')}}/><QuickCustomerModal open={open} onClose={()=>setOpen(false)} onCreated={c=>{fixture.selected.push(c);const discount=customerDiscountPct(c);const s=usePOSStore.getState();s.setCustomer({id:c.id,phone:c.phone,name:c.full_name,debtBalance:0,tierDiscountPct:discount,tierName:c.price_tier?.name??null,vipLevel:'standard',riskProfile:'low'});s.setAutomaticDiscountPct(discount)}}/></div>}
function App(){const location=useLocation();return <><NavigationGuard/><div data-testid="location">{location.pathname}</div><Routes><Route path="/customers" element={<Customers/>}/><Route path="/customers/new" element={<Form/>}/><Route path="/customers/:id" element={<p>Збережена картка</p>}/><Route path="/pos" element={<PosCreation/>}/></Routes></>}
createRoot(document.getElementById('root')).render(<RouterProvider router={createMemoryRouter([{path:'*',element:<App/>}],{initialEntries:[fixture.route]})}/>);`
const bootstrap = `
window.fixture={role:window.testRole??'owner',route:window.testRoute??'/pos',errors:[],messages:[],writes:[],reads:[],selected:[],pauseWrites:false};
window.IntersectionObserver=class{observe(){}disconnect(){}};
fixture.customers={list:async params=>{fixture.reads.push(params);return{data:[],pagination:{total:0,total_pages:1,page:1,per_page:50}}},create:async body=>{fixture.writes.push(body);if(fixture.pauseWrites)await new Promise(resolve=>fixture.release=resolve);if(fixture.failNext){fixture.failNext=false;throw Error('Synthetic create failure')}return{data:{...body,id:'synthetic-created',loyalty_mode:body.loyalty_mode??'discount',debt_balance:0,bonus_balance:0,deposit_balance:0,price_tier:body.price_tier_id?{id:'tier',name:'СТО',discount_pct:10}:null}}}};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
  name: 'customer-creation-smoke', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:customer-creation.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:customer-creation.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(instance) { instance.middlewares.use('/customer-creation-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await instance.transformIndexHtml('/customer-creation-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:customer-creation.tsx"></script></body></html>')) }) },
}] })
let browser
const pageErrors = [], blocked = [], passed = []
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0]
  async function setup(route = '/pos', role = 'owner') {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => { pageErrors.push(error.message); console.error(error.message) })
    await page.route('**/*', request => new URL(request.request().url()).origin === new URL(base).origin ? request.continue() : (blocked.push(request.request().url()), request.abort()))
    await page.addInitScript(({ route, role }) => { window.testRoute = route; window.testRole = role }, { route, role })
    await page.goto(base + 'customer-creation-test')
    await page.getByTestId('location').waitFor()
    return page
  }
  for (const [query, entrypoint, expected] of [
    ['+380 (67) 123-45-67', 'empty', '+380671234567'],
    ['(067) 123-45-67', 'tab', '+380671234567'],
    ['Іван', 'empty', ''],
    ['WVWZZZ1KZAW123456', 'tab', ''],
  ]) {
    const page = await setup()
    await page.getByLabel("Ім'я або телефон").fill(query)
    await page.waitForFunction(value => fixture.reads.some(read => read.search === value), query)
    await page.getByRole('button', { name: entrypoint === 'empty' ? 'Створити нового' : 'Новий клієнт', exact: true }).click()
    assert.equal(await page.getByLabel('Телефон *', { exact: true }).inputValue(), expected)
    assert.equal(await page.evaluate(() => fixture.writes.length), 0)
    passed.push('prefill:' + entrypoint + ':' + query)
    await page.close()
  }

  for (const [role, mode, tier, discount, expectedTotal] of [
    ['owner', 'cashback', '', '7.5', 20000],
    ['owner', 'discount', '', '5', 19000],
    ['manager', 'discount', 'tier', '5', 18000],
    ['cashier', 'discount', '', '5', 19000],
  ]) {
    const page = await setup('/pos', role)
    await page.getByRole('button', { name: 'Новий клієнт', exact: true }).click()
    await page.getByLabel('Телефон *', { exact: true }).fill('0671234567')
    await page.getByLabel("Ім'я", { exact: true }).fill('Клієнт перевірки')
    if (role === 'cashier') assert.equal(await page.getByLabel('Процент працює як', { exact: true }).count(), 0)
    else await page.getByLabel('Процент працює як', { exact: true }).selectOption(mode)
    await page.getByLabel(mode === 'cashback' ? 'Накопичення (%)' : 'Персональна знижка (%)', { exact: true }).fill(discount)
    if (tier) {
      await page.getByLabel('Ціновий рівень', { exact: true }).selectOption(tier)
      await page.getByText(/«СТО» — 10%/).waitFor()
    }
    await page.getByRole('button', { name: 'Створити й додати до чека', exact: true }).click()
    await page.waitForFunction(() => fixture.selected.length === 1)
    const result = await page.evaluate(() => ({ payload: fixture.writes[0], selected: fixture.selected[0], total: fixture.store.getState().total, items: fixture.store.getState().items }))
    assert.equal(result.payload.discount_pct, Number(discount))
    assert.equal(result.total, expectedTotal)
    assert.equal(result.items.length, 1); assert.equal(result.items[0].qty, 2)
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.locator('.receipt-header').getByText('Клієнт перевірки', { exact: true }).waitFor()
    if (role === 'cashier') {
      assert.equal('loyalty_mode' in result.payload, false)
      assert.equal('price_tier_id' in result.payload, false)
    } else assert.equal(result.payload.loyalty_mode, mode)
    passed.push('pos-create:' + role + ':' + mode + ':' + tier)
    await page.close()
  }

  for (const role of ['owner', 'cashier']) {
    const page = await setup('/customers', role)
    await page.getByRole('button', { name: 'Новий клієнт', exact: true }).click()
    await page.getByLabel('Телефон *', { exact: true }).fill('0671234567')
    await page.getByLabel("Ім'я", { exact: true }).fill('Клієнт зі списку')
    if (role === 'owner') {
      await page.getByLabel('Процент працює як', { exact: true }).selectOption('cashback')
      await page.getByLabel('Накопичення (%)', { exact: true }).fill('8')
    } else {
      assert.equal(await page.getByLabel('Процент працює як', { exact: true }).count(), 0)
      await page.getByLabel('Персональна знижка (%)', { exact: true }).fill('8')
    }
    await page.getByRole('button', { name: 'Створити клієнта', exact: true }).click()
    await page.getByText('Збережена картка', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('location').textContent(), '/customers/synthetic-created')
    assert.equal(await page.evaluate(() => fixture.writes.length), 1)
    assert.equal(await page.evaluate(() => fixture.writes[0].discount_pct), 8)
    assert.equal(await page.evaluate(() => fixture.writes[0].loyalty_mode), role === 'owner' ? 'cashback' : undefined)
    passed.push('list-create:' + role)
    await page.close()
  }

  const retry = await setup()
  await retry.getByRole('button', { name: 'Новий клієнт', exact: true }).click()
  await retry.getByLabel('Телефон *', { exact: true }).fill('0671234567')
  await retry.getByLabel('Процент працює як', { exact: true }).selectOption('cashback')
  await retry.getByLabel('Накопичення (%)', { exact: true }).fill('6')
  await retry.evaluate(() => { fixture.failNext = true })
  await retry.getByRole('button', { name: 'Створити й додати до чека', exact: true }).click()
  await retry.waitForFunction(() => fixture.errors.includes('Synthetic create failure'))
  assert.equal(await retry.getByLabel('Накопичення (%)', { exact: true }).inputValue(), '6')
  assert.equal(await retry.getByLabel('Процент працює як', { exact: true }).inputValue(), 'cashback')
  await retry.evaluate(() => { fixture.pauseWrites = true })
  await retry.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await retry.waitForFunction(() => fixture.writes.length === 2)
  assert.equal(await retry.evaluate(() => fixture.selected.length), 0)
  await retry.evaluate(() => fixture.release())
  await retry.waitForFunction(() => fixture.selected.length === 1)
  assert.equal(await retry.evaluate(() => fixture.writes.length), 2)
  passed.push('failed-create-preserves-input-and-double-submit-is-serialized')
  await retry.close()
  assert.deepEqual(pageErrors, []); assert.deepEqual(blocked, [])
  console.log(JSON.stringify({ passed: true, cases: passed, liveWrites: 0, externalRequests: 0, note: 'Actual creation forms, customer list and receipt panel/store; POS callback integration is reproduced by the isolated harness.' }))
} finally { await browser?.close(); await server.close() }
