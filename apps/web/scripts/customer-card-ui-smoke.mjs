// Real customer pages and shared contextual editors, synthetic APIs only.
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
  '@/features/customers/customerVehiclesApi': 'export const customerVehiclesApi=fixture.vehicles',
  '@/features/customers/customerGroupsApi': 'export const customerGroupsApi={list:async()=>({data:[]})}',
  '@/features/pos/posCustomerMoneyApi': 'export const posCustomerMoneyApi={getDeposit:async()=>({data:{balance:3000}})}',
  '@/features/admin/pricingApi': 'export const pricingApi={listTiers:async()=>({data:[{id:"tier",name:"Гурт",discount_pct:10}]})}',
  '@/features/orders/orderApi': 'export const orderApi={list:async()=>({data:[{id:"order-1",items:[],status:"new",order_number:"SYNTHETIC-ORDER",total_amount:5000,total_paid:1000,created_at:"2026-10-01T12:00:00Z"}],meta:{has_more:false}})}',
  '@/features/orders/orderActions': 'export const formatOrderNo=o=>o.order_number;export const startRepeatOrder=()=>{throw new Error("Unexpected repeat")}',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({pos:{customerHistory:async(id,kind)=>({data:kind==="sales"?[{id:"sale",sale_number:"SYNTHETIC-SALE",completed_at:"2026-10-01T12:00:00Z",total:12000,payment_method:"cash"}]:[{id:"deposit",amount:3000,balance_after:3000,created_at:"2026-10-01T12:00:00Z",method:"cash"}],has_more:false})}});export const isDesktopRuntime=()=>true',
  '@/lib/offlineDB': 'export const searchCustomersOffline=async()=>[]',
  '@/lib/api': 'export const api={get:()=>{throw new Error("Unexpected remote read")},post:()=>{throw new Error("Unexpected remote write")}}',
  '@/stores/authStore': 'export const useAuthStore=select=>select({session:{user:{id:"synthetic-owner",app_metadata:{role:fixture.role}}},offlineMode:false})',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.errors.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children,title,onBack,actions}){return <main id="app-main-scroll"><h1>{title}</h1>{onBack&&<button onClick={onBack}>Назад</button>}{actions}{children}</main>}',
}
const entry = `
import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{createMemoryRouter,RouterProvider,Routes,Route,useNavigate,useLocation}from'react-router-dom';
import Customers from'/src/features/customers/CustomersPage.tsx';import Detail from'/src/features/customers/CustomerDetailPage.tsx';import Form from'/src/features/customers/CustomerFormPage.tsx';import{QuickCustomerModal}from'/src/features/customers/QuickCustomerModal.tsx';import{QuickCustomerEditModal}from'/src/features/customers/QuickCustomerEditModal.tsx';import{NavigationGuard}from'/src/hooks/useUnsavedChanges.ts';import'/src/index.css';
function Contextual(){const[search,setSearch]=useState(true),[edit,setEdit]=useState(false),[resume,setResume]=useState(false);return <><QuickCustomerModal open={search} resumeSearch={resume} onClose={()=>{setSearch(false);setResume(false)}} onCreated={c=>fixture.selected.push(c)} onEdit={()=>{setResume(true);setSearch(false);setEdit(true)}}/><QuickCustomerEditModal customer={fixture.customer} open={edit} onClose={()=>{setEdit(false);if(resume)setSearch(true)}} onSaved={c=>{fixture.customer=c;fixture.saved.push(c)}}/></>}
function App(){const navigate=useNavigate(),location=useLocation();useEffect(()=>{fixture.go=navigate},[navigate]);return <><NavigationGuard/><div data-testid="location">{location.pathname}</div><button onClick={()=>navigate('/other')}>Інший розділ</button><Routes><Route path="/customers" element={<Customers/>}/><Route path="/customers/new" element={<Form/>}/><Route path="/customers/:id/edit" element={<Form/>}/><Route path="/customers/:id" element={<Detail/>}/><Route path="/contextual" element={<Contextual/>}/><Route path="*" element={<p>Destination</p>}/></Routes></>}
createRoot(document.getElementById('root')).render(<RouterProvider router={createMemoryRouter([{path:'*',element:<App/>}],{initialEntries:[fixture.route]})}/>);`
const bootstrap = `
window.fixture={role:window.testRole??'owner',route:window.testRoute??'/customers/a',errors:[],messages:[],writes:[],reads:[],saved:[],selected:[],cars:[],pauseWrites:false};
fixture.observers=[];window.IntersectionObserver=class{constructor(callback){this.callback=callback;fixture.observers.push(this)}observe(){}disconnect(){}};
fixture.customer={id:'a',phone:'00123456',full_name:'Client A',email:'',birth_date:'1990-01-02',notes:'',tags:['VIP','Власний тег'],card_barcode:'000123',discount_pct:5,client_status:'client',loyalty_mode:'discount',bonus_balance:2000,debt_balance:1000,deposit_balance:3000,price_tier_id:null,price_tier:null,vip_level:'standard',risk_profile:'low',updated_at:'v1',created_at:'2026-01-01T00:00:00Z',primary_vin:null};
fixture.finish=async(kind,body,result)=>{fixture.writes.push({kind,body});if(fixture.pauseWrites)await new Promise(resolve=>fixture.release=resolve);if(fixture.failNext){fixture.failNext=false;throw Error('Synthetic save failure')}return result()};
fixture.customers={get:async()=>({data:{...fixture.customer}}),list:async p=>{fixture.reads.push(p);const page=p.page??1;return{data:page===1?[{...fixture.customer}]:[{...fixture.customer,id:'b',full_name:'Client B'}],pagination:{total:2,total_pages:2,page,per_page:50}}},update:async(id,body)=>fixture.finish('customer',{id,...body},()=>({data:fixture.customer={...fixture.customer,...body,updated_at:'v2'}})),create:async body=>fixture.finish('create',body,()=>({data:fixture.customer={...fixture.customer,...body}})),delete:async()=>{throw new Error('Unexpected delete')}};
fixture.vehicles={list:async()=>({data:[...fixture.cars]}),create:async(id,body)=>fixture.finish('car',body,()=>{const car={...body,id:'car-1',customer_id:id};fixture.cars.push(car);return{data:car}}),update:async()=>{throw new Error('Unexpected vehicle update')},delete:async(id,carId)=>fixture.finish('car-delete',{id,carId},()=>{fixture.cars=fixture.cars.filter(c=>c.id!==carId)})};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 }, plugins: [tailwindcss(), {
  name: 'customer-card-smoke', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:customer-card.tsx' || Object.hasOwn(mocks, id)) return '\0' + id },
  async load(id) {
    if (id === '\0virtual:customer-card.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })
    let source = id.startsWith('\0') ? mocks[id.slice(1)] : undefined
    for (const [name, mock] of Object.entries(mocks)) if (id.replaceAll('\\', '/').replace(/\.tsx?$/, '').endsWith('/src/' + name.slice(2))) source = mock
    if (source) return transformWithEsbuild(source, 'mock.tsx', { loader: 'tsx', jsx: 'automatic' })
  },
  configureServer(instance) { instance.middlewares.use('/customer-test', async (_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await instance.transformIndexHtml('/customer-test', '<html><body><div id="root"></div><script>' + bootstrap + '</script><script type="module" src="/@id/__x00__virtual:customer-card.tsx"></script></body></html>')) }) },
}] })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const base = server.resolvedUrls.local[0], errors = [], blocked = []
  async function setup(route = '/customers/a', role = 'owner') {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', request => new URL(request.request().url()).origin === new URL(base).origin ? request.continue() : (blocked.push(request.request().url()), request.abort()))
    await page.addInitScript(({ route, role }) => { window.testRoute = route; window.testRole = role }, { route, role })
    await page.goto(base + 'customer-test')
    await page.waitForFunction(() => typeof fixture.go === 'function')
    return page
  }
  const card = await setup()
  await card.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  assert.equal(await card.getByRole('dialog').count(), 0)
  for (const name of ['Історія клієнта', 'Чек №SYNTHETIC-SALE', 'SYNTHETIC-ORDER', 'Клієнт винен магазину', 'Кошти клієнта']) await card.getByText(name, { exact: true }).waitFor()
  await card.getByRole('button', { name: 'Власний тег', exact: true }).waitFor()
  await card.getByLabel("Ім'я", { exact: true }).fill('Edited client')
  await card.getByRole('button', { name: 'СТО', exact: true }).click()
  await card.getByRole('button', { name: 'Зберегти картку', exact: true }).click()
  await card.waitForFunction(() => fixture.writes.filter(w => w.kind === 'customer').length === 1)
  assert.equal(await card.getByTestId('location').textContent(), '/customers/a')
  assert.deepEqual(await card.evaluate(() => fixture.writes[0].body.tags), ['VIP', 'Власний тег', 'СТО'])
  await card.getByLabel('Марка *', { exact: true }).fill('Honda')
  await card.getByLabel('Модель *', { exact: true }).fill('Civic')
  await card.getByRole('button', { name: 'Додати автомобіль', exact: true }).click()
  await card.getByText('Honda Civic', { exact: true }).waitFor()
  assert.equal(await card.evaluate(() => fixture.writes.filter(w => w.kind === 'customer').length), 1)
  await card.getByLabel('Вид історії').selectOption('deposit')
  await card.getByText('Операція рахунку', { exact: true }).waitFor()
  await card.getByLabel("Ім'я", { exact: true }).fill('Unsaved')
  const rejectDialog = card.waitForEvent('dialog')
  const rejectNavigation = card.getByRole('button', { name: 'Інший розділ', exact: true }).click()
  await (await rejectDialog).dismiss()
  await rejectNavigation
  assert.equal(await card.getByTestId('location').textContent(), '/customers/a')
  assert.equal(await card.getByLabel("Ім'я", { exact: true }).inputValue(), 'Unsaved')
  const acceptDialog = card.waitForEvent('dialog')
  const acceptNavigation = card.getByRole('button', { name: 'Інший розділ', exact: true }).click()
  await (await acceptDialog).accept()
  await acceptNavigation
  await card.waitForFunction(() => document.querySelector('[data-testid="location"]').textContent === '/other')
  await card.close()

  const cashier = await setup('/customers/a', 'cashier')
  await cashier.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  assert.equal(await cashier.getByLabel('Бонусів на рахунку, грн').count(), 0)
  await cashier.getByLabel('Персональна знижка, %', { exact: true }).fill('8')
  await cashier.getByRole('button', { name: 'Зберегти картку', exact: true }).click()
  await cashier.waitForFunction(() => fixture.writes.length === 1)
  assert.equal(await cashier.evaluate(() => fixture.writes[0].body.discount_pct), 8)
  assert.equal(await cashier.evaluate(() => 'bonus_balance' in fixture.writes[0].body), false)
  await cashier.close()

  const viewer = await setup('/customers/a', 'tire_worker')
  await viewer.getByText('Історія клієнта', { exact: true }).waitFor()
  assert.equal(await viewer.getByRole('button', { name: 'Зберегти картку', exact: true }).count(), 0)
  assert.equal(await viewer.evaluate(() => fixture.writes.length), 0)
  await viewer.close()

  const alias = await setup('/customers/a/edit')
  await alias.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  assert.equal(await alias.getByTestId('location').textContent(), '/customers/a')
  await alias.close()

  const list = await setup('/customers')
  const search = list.getByPlaceholder('Телефон, ім’я, VIN або штрихкод картки...')
  await search.fill('Client')
  await list.getByText('Client A', { exact: true }).waitFor()
  await list.waitForFunction(() => fixture.reads.some(read => read.search === 'Client'))
  await list.evaluate(() => fixture.observers.at(-1).callback([{ isIntersecting: true }]))
  await list.getByText('Client B', { exact: true }).waitFor()
  await list.getByText('Client A', { exact: true }).click()
  await list.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  assert.equal(await list.getByRole('dialog').count(), 0)
  const readsBeforeReturn = await list.evaluate(() => fixture.reads.length)
  await list.getByRole('button', { name: 'Назад', exact: true }).click()
  await list.getByText('Client B', { exact: true }).waitFor()
  assert.equal(await search.inputValue(), 'Client')
  assert.deepEqual(await list.evaluate(start => fixture.reads.slice(start).map(read => read.page), readsBeforeReturn), [1, 2])
  await list.close()

  const busy = await setup()
  await busy.getByLabel("Ім'я", { exact: true }).fill('Pending save')
  await busy.evaluate(() => { fixture.pauseWrites = true })
  await busy.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await busy.waitForFunction(() => fixture.writes.length === 1)
  const busyDialog = busy.waitForEvent('dialog')
  const busyNavigation = busy.getByRole('button', { name: 'Інший розділ', exact: true }).click()
  const waiting = await busyDialog
  assert.equal(waiting.type(), 'alert')
  await waiting.accept(); await busyNavigation
  assert.equal(await busy.getByTestId('location').textContent(), '/customers/a')
  await busy.evaluate(() => fixture.release())
  await busy.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  await busy.waitForFunction(() => fixture.customer.full_name === 'Pending save')
  assert.equal(await busy.evaluate(() => fixture.writes.length), 1)
  await busy.close()

  const create = await setup('/customers/new')
  await create.getByLabel('Телефон *', { exact: true }).fill('00111222')
  const cancelDialog = create.waitForEvent('dialog')
  const cancelClick = create.getByRole('button', { name: 'Скасувати', exact: true }).click()
  await (await cancelDialog).dismiss(); await cancelClick
  assert.equal(await create.getByLabel('Телефон *', { exact: true }).inputValue(), '00111222')
  await create.evaluate(() => { fixture.failNext = true })
  await create.getByRole('button', { name: 'Створити клієнта', exact: true }).click()
  await create.waitForFunction(() => fixture.errors.includes('Synthetic save failure'))
  assert.equal(await create.getByLabel('Телефон *', { exact: true }).inputValue(), '00111222')
  assert.equal(await create.getByTestId('location').textContent(), '/customers/new')
  await create.getByRole('button', { name: 'Створити клієнта', exact: true }).click()
  await create.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  assert.equal(await create.getByTestId('location').textContent(), '/customers/a')
  assert.equal(await create.evaluate(() => fixture.writes.filter(write => write.kind === 'create').length), 2)
  await create.close()

  const contextual = await setup('/contextual')
  await contextual.getByLabel("Ім'я або телефон").fill('Client')
  await contextual.getByRole('button', { name: 'Ред.', exact: true }).click()
  await contextual.getByLabel("Ім'я", { exact: true }).fill('New name')
  await contextual.getByRole('button', { name: 'Зберегти картку', exact: true }).click()
  await contextual.getByLabel("Ім'я або телефон").waitFor()
  assert.equal(await contextual.getByLabel("Ім'я або телефон").inputValue(), 'Client')
  await contextual.getByText('New name', { exact: true }).waitFor()
  assert.equal(await contextual.evaluate(() => fixture.selected.length), 0)
  await contextual.close()
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: canonical inline card; shared fields/tags and role permissions; garage updates without customer resave; preserved distinct orders/receipts/account balances; dirty route stay/leave; busy duplicate submit/navigation protection; legacy edit redirect; list search and loaded pages 1..2 restored; contextual edit restores search without selecting a different check customer. Zero external requests/page errors. Synthetic only.')
} finally { await browser?.close(); await server.close() }
