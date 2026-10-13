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
  '@/features/pos/saleApi': 'export const saleApi={get:async id=>{fixture.saleReads.push(id);if(fixture.failSale){fixture.failSale=false;throw Error("Synthetic receipt read failure")}return{data:fixture.sale}}}',
  '@/features/pos/ReceiptPrint': 'export const printReceipt=()=>fixture.prints++;export function ReceiptPrint(){return null}',
  '@/features/customers/customerGroupsApi': 'export const customerGroupsApi={list:async()=>({data:[]})}',
  '@/features/pos/posCustomerMoneyApi': 'export const posCustomerMoneyApi={getDeposit:async()=>({data:{balance:3000}})}',
  '@/features/admin/pricingApi': 'export const pricingApi={listTiers:async()=>({data:[{id:"tier",name:"Гурт",discount_pct:10}]})}',
  '@/features/orders/orderApi': 'export const orderApi={list:(offset,opts,limit,filters)=>fixture.readOrders(offset,limit,filters)}',
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
window.fixture={role:window.testRole??'owner',route:window.testRoute??'/customers/a',orderScenario:window.testOrders,orderReads:[],errors:[],messages:[],writes:[],reads:[],saved:[],selected:[],cars:[],pauseWrites:false};
fixture.observers=[];window.IntersectionObserver=class{constructor(callback){this.callback=callback;fixture.observers.push(this)}observe(){}disconnect(){}};
fixture.customer={id:'a',phone:'00123456',full_name:'Client A',email:'',birth_date:'1990-01-02',notes:'',tags:['VIP','Власний тег'],card_barcode:'000123',discount_pct:5,client_status:'client',loyalty_mode:'discount',bonus_balance:2000,debt_balance:1000,deposit_balance:3000,price_tier_id:null,price_tier:null,vip_level:'standard',risk_profile:'low',updated_at:'v1',created_at:'2026-01-01T00:00:00Z',primary_vin:null};
fixture.saleReads=[];fixture.prints=0;fixture.sale={id:'sale',sale_number:'SYNTHETIC-SALE',completed_at:'2026-10-01T12:00:00Z',total:12000,discount:0,status:'completed',payment_method:'cash',cashier_id:'cashier',manager_id:'manager',is_order_sale:true,cashier:{id:'cashier',full_name:'Касир чека'},manager:{id:'manager',full_name:'Менеджер замовлення',is_active:false},sale_items:[{id:'line',qty:1,unit_price:12000,total:12000,product:{name:'Історичний товар'}},{id:'third',qty:1,unit_price:0,total:0,product:{name:'Третя позиція для перевірки'}}]};
fixture.finish=async(kind,body,result)=>{fixture.writes.push({kind,body});if(fixture.pauseWrites)await new Promise(resolve=>fixture.release=resolve);if(fixture.failNext){fixture.failNext=false;throw Error('Synthetic save failure')}return result()};
fixture.customers={get:async id=>({data:{...fixture.customer,id}}),list:async p=>{fixture.reads.push(p);const page=p.page??1;return{data:page===1?[{...fixture.customer}]:[{...fixture.customer,id:'b',full_name:'Client B'}],pagination:{total:2,total_pages:2,page,per_page:50}}},update:async(id,body)=>fixture.finish('customer',{id,...body},()=>({data:fixture.customer={...fixture.customer,...body,updated_at:'v2'}})),create:async body=>fixture.finish('create',body,()=>({data:fixture.customer={...fixture.customer,...body}})),delete:async()=>{throw new Error('Unexpected delete')}};
fixture.readOrders=async(offset=0,limit=25,filters={})=>{fixture.orderReads.push({offset,limit,...filters});const orders=Array.from({length:fixture.orderScenario&&filters.customer_id==='a'?61:1},(_,i)=>({id:'order-'+filters.customer_id+'-'+i,customer_id:filters.customer_id,chat_id:null,items:[],status:'new',order_number:fixture.orderScenario?'ORDER-'+filters.customer_id+'-'+i:'SYNTHETIC-ORDER',total_amount:5000,total_paid:1000,created_at:'2026-10-01T12:00:00Z'}));if(fixture.failMore&&offset>0){fixture.failMore=false;throw Error('Synthetic older history unavailable')}if(fixture.holdMore&&offset>0)await new Promise(resolve=>fixture.releaseOrders=resolve);return{data:orders.slice(offset,offset+limit),meta:{has_more:orders.length>offset+limit,offset,per_page:limit}}};
fixture.vehicles={list:async()=>({data:[...fixture.cars]}),create:async(id,body)=>fixture.finish('car',body,()=>{const car={...body,id:'car-1',customer_id:id};fixture.cars.push(car);return{data:car}}),update:async()=>{throw new Error('Unexpected vehicle update')},delete:async(id,carId)=>fixture.finish('car-delete',{id,carId},()=>{fixture.cars=fixture.cars.filter(c=>c.id!==carId)})};
`
const server = await createServer({ cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error', esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [tailwindcss(), {
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
  async function setup(route = '/customers/a', role = 'owner', orders = false) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', request => new URL(request.request().url()).origin === new URL(base).origin ? request.continue() : (blocked.push(request.request().url()), request.abort()))
    await page.addInitScript(({ route, role, orders }) => { window.testRoute = route; window.testRole = role; window.testOrders = orders }, { route, role, orders })
    await page.goto(base + 'customer-test')
    await page.waitForFunction(() => typeof fixture.go === 'function')
    return page
  }
  const card = await setup()
  await card.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  const carSelection = await setup()
  await carSelection.getByRole('button', { name: 'Зберегти картку', exact: true }).waitFor()
  await carSelection.evaluate(() => fixture.cars = [
    { id: 'car-one', customer_id: 'a', brand: 'Honda', model: 'Civic', year: 2010, vin: 'VIN-ONE', notes: '' },
    { id: 'car-two', customer_id: 'a', brand: 'Toyota', model: 'Yaris', year: 2015, vin: 'VIN-TWO', notes: '' },
  ])
  await carSelection.getByRole('button', { name: 'Оновити дані', exact: true }).click()
  await carSelection.getByRole('button', { name: /Honda Civic/ }).click()
  assert.equal(await carSelection.getByRole('button', { name: 'Зберегти картку', exact: true }).isDisabled(), false, 'merely selecting an existing unchanged car is not a pending vehicle edit')
  await carSelection.locator('input[required]').fill('00123457')
  await carSelection.getByRole('button', { name: 'Зберегти картку', exact: true }).click()
  await carSelection.waitForFunction(() => fixture.writes.length === 1)
  assert.equal(await carSelection.evaluate(() => fixture.writes[0].kind), 'customer')
  await carSelection.getByLabel('Модель *', { exact: true }).fill('Civic edited')
  assert.equal(await carSelection.getByRole('button', { name: 'Зберегти картку', exact: true }).isDisabled(), true)
  const rejectCar = carSelection.waitForEvent('dialog'), switchingCar = carSelection.getByRole('button', { name: /Toyota Yaris/ }).click()
  await (await rejectCar).dismiss(); await switchingCar
  assert.equal(await carSelection.getByLabel('Модель *', { exact: true }).inputValue(), 'Civic edited')
  const acceptCar = carSelection.waitForEvent('dialog'), acceptSwitch = carSelection.getByRole('button', { name: /Toyota Yaris/ }).click()
  await (await acceptCar).accept(); await acceptSwitch
  assert.equal(await carSelection.getByLabel('Модель *', { exact: true }).inputValue(), 'Yaris')
  assert.equal(await carSelection.getByRole('button', { name: 'Зберегти картку', exact: true }).isDisabled(), false)
  assert.equal(await carSelection.evaluate(() => fixture.writes.filter(write => write.kind !== 'customer').length), 0, 'viewing/switching cars never writes them')
  await carSelection.getByRole('button', { name: 'Скасувати', exact: true }).click()
  assert.equal(await carSelection.getByLabel('Марка *', { exact: true }).inputValue(), '')
  await carSelection.close()
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

  const sequence = await setup()
  await sequence.getByLabel("Ім'я", { exact: true }).fill('Card and car draft')
  await sequence.getByLabel('Марка *', { exact: true }).fill('Toyota')
  await sequence.getByLabel('Модель *', { exact: true }).fill('Corolla')
  const saveCard = sequence.getByRole('button', { name: 'Зберегти картку', exact: true })
  assert.equal(await saveCard.isDisabled(), true, 'Car draft must explain and block card save before a failed submit')
  await sequence.getByText('Спочатку збережіть автомобіль або скасуйте його зміни. Потім збережіть картку клієнта.', { exact: true }).waitFor()
  await sequence.evaluate(() => { fixture.failNext = true })
  await sequence.getByRole('button', { name: 'Додати автомобіль', exact: true }).click()
  await sequence.waitForFunction(() => fixture.errors.includes('Synthetic save failure'))
  assert.equal(await sequence.getByLabel('Модель *', { exact: true }).inputValue(), 'Corolla')
  assert.equal(await sequence.getByLabel("Ім'я", { exact: true }).inputValue(), 'Card and car draft')
  assert.equal(await saveCard.isDisabled(), true)
  await sequence.getByRole('button', { name: 'Додати автомобіль', exact: true }).click()
  await sequence.getByText('Toyota Corolla', { exact: true }).waitFor()
  assert.equal(await saveCard.isEnabled(), true)
  await sequence.evaluate(() => { fixture.failNext = true })
  await saveCard.click()
  await sequence.waitForFunction(() => fixture.writes.filter(w => w.kind === 'customer').length === 1)
  assert.equal(await sequence.getByLabel("Ім'я", { exact: true }).inputValue(), 'Card and car draft')
  await saveCard.click()
  await sequence.waitForFunction(() => fixture.writes.filter(w => w.kind === 'customer').length === 2)
  assert.equal(await sequence.evaluate(() => fixture.cars.length), 1, 'Retrying card save must not recreate the saved car')
  assert.equal(await sequence.evaluate(() => fixture.writes.filter(w => w.kind === 'car').length), 2)
  await sequence.getByLabel("Ім'я", { exact: true }).fill('Keep card changes')
  await sequence.getByLabel('Марка *', { exact: true }).fill('Discard car only')
  await sequence.getByRole('button', { name: 'Скасувати', exact: true }).click()
  assert.equal(await sequence.getByLabel('Марка *', { exact: true }).inputValue(), '')
  assert.equal(await sequence.getByLabel("Ім'я", { exact: true }).inputValue(), 'Keep card changes')
  assert.equal(await saveCard.isEnabled(), true)
  await sequence.close()

  const history = await setup()
  await history.getByLabel('Історія від').fill('2026-09-01')
  await history.getByRole('button', { name: 'Чек №SYNTHETIC-SALE', exact: true }).click()
  await history.getByRole('dialog', { name: 'Чек #SYNTHETIC-SALE' }).waitFor()
  await history.getByText('Історичний товар', { exact: true }).waitFor()
  await history.getByText('Третя позиція для перевірки', { exact: true }).waitFor()
  await history.getByText('Касир чека', { exact: true }).waitFor()
  await history.getByText('Менеджер замовлення (неактивний)', { exact: true }).waitFor()
  assert.equal(await history.evaluate(() => fixture.prints), 0, 'Viewing a historical receipt never prints it')
  await history.getByRole('dialog').getByRole('button', { name: 'Закрити', exact: true }).last().click()
  assert.equal(await history.getByLabel('Історія від').inputValue(), '2026-09-01')
  assert.equal(await history.getByTestId('location').textContent(), '/customers/a')
  await history.evaluate(() => { fixture.failSale = true })
  await history.getByRole('button', { name: 'Чек №SYNTHETIC-SALE', exact: true }).click()
  await history.getByRole('alert').getByText('Synthetic receipt read failure').waitFor()
  await history.getByRole('button', { name: 'Повторити', exact: true }).click()
  await history.getByRole('dialog', { name: 'Чек #SYNTHETIC-SALE' }).waitFor()
  await history.getByRole('button', { name: 'Оформити повернення', exact: true }).click()
  await history.waitForFunction(() => document.querySelector('[data-testid="location"]').textContent === '/returns')
  assert.equal(await history.evaluate(() => fixture.prints), 0)
  await history.close()

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
  for (const zoom of [1.25, 1.5]) {
    const compact = await setup('/contextual')
    await compact.setViewportSize({ width: 1366, height: 768 })
    await compact.evaluate(value => { document.body.style.zoom = String(value) }, zoom)
    await compact.getByLabel("Ім'я або телефон").fill('Client')
    await compact.getByRole('button', { name: 'Ред.', exact: true }).click()
    const action = compact.getByRole('button', { name: 'Зберегти картку', exact: true })
    await action.waitFor()
    const box = await action.boundingBox()
    if (!box || box.y < 0 || box.y + box.height > 768) console.log('compact layout', await compact.getByRole('dialog').evaluate(element => ({dialog:element.getBoundingClientRect().toJSON(),parent:element.parentElement.getBoundingClientRect().toJSON(),scroll:element.lastElementChild.getBoundingClientRect().toJSON(),button:Array.from(element.querySelectorAll('button')).find(button=>button.textContent.includes('Зберегти картку'))?.getBoundingClientRect().toJSON()})))
    assert.ok(box && box.y >= 0 && box.y + box.height <= 768, 'Existing customer save must stay in the viewport at ' + zoom)
    assert.equal(await compact.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await compact.close()
  }
  const historyPages = await setup('/customers/a', 'owner', true)
  await historyPages.getByText('ORDER-a-24', { exact: true }).waitFor()
  await historyPages.getByLabel("Ім'я", { exact: true }).fill('Unsaved during paging')
  await historyPages.evaluate(() => fixture.failMore = true)
  await historyPages.getByRole('button', { name: 'Ще замовлення', exact: true }).click()
  await historyPages.getByRole('alert').filter({ hasText: 'Історію завантажено не повністю' }).waitFor()
  assert.equal(await historyPages.getByText('ORDER-a-24', { exact: true }).count(), 1)
  assert.equal(await historyPages.getByLabel("Ім'я", { exact: true }).inputValue(), 'Unsaved during paging')
  await historyPages.getByRole('button', { name: 'Ще замовлення', exact: true }).click()
  await historyPages.getByText('ORDER-a-49', { exact: true }).waitFor()
  await historyPages.getByRole('button', { name: 'Ще замовлення', exact: true }).click()
  await historyPages.getByText('ORDER-a-60', { exact: true }).waitFor()
  await historyPages.getByRole('heading', { name: 'Замовлення (61)', exact: true }).waitFor()
  assert.equal(await historyPages.getByRole('button', { name: 'Ще замовлення', exact: true }).count(), 0)
  assert.deepEqual(await historyPages.evaluate(() => fixture.orderReads.map(read => [read.customer_id, read.offset, read.limit])), [['a',0,25],['a',25,25],['a',25,25],['a',50,25]])
  assert.equal(await historyPages.evaluate(() => fixture.writes.length), 0)
  await historyPages.close()
  const historyRace = await setup('/customers/a', 'owner', true)
  await historyRace.getByText('ORDER-a-24', { exact: true }).waitFor()
  await historyRace.evaluate(() => fixture.holdMore = true)
  await historyRace.getByRole('button', { name: 'Ще замовлення', exact: true }).click()
  await historyRace.waitForFunction(() => typeof fixture.releaseOrders === 'function')
  await historyRace.evaluate(() => fixture.go('/customers/b'))
  await historyRace.getByText('ORDER-b-0', { exact: true }).waitFor()
  await historyRace.evaluate(() => fixture.releaseOrders())
  await historyRace.waitForTimeout(100)
  assert.equal(await historyRace.getByText(/^ORDER-a-/).count(), 0, 'old customer response must not enter the new customer history')
  assert.equal(await historyRace.evaluate(() => fixture.writes.length), 0)
  await historyRace.close()
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: canonical inline card; shared fields/tags and role permissions; garage updates without customer resave; preserved distinct orders/receipts/account balances; dirty route stay/leave; busy duplicate submit/navigation protection; legacy edit redirect; list search and loaded pages 1..2 restored; contextual edit restores search without selecting a different check customer. Zero external requests/page errors. Synthetic only.')
} finally { await browser?.close(); await server.close() }
