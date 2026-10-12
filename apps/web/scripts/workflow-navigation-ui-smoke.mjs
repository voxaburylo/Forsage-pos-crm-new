// Real workflow pages, synthetic read APIs, isolated browser storage, blocked external traffic.
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
  '@/components/Layout': 'export function Layout({children,title,onBack,actions}){return <main><h1>{title}</h1>{onBack&&<button onClick={onBack}>Test back</button>}{actions}{children}</main>}',
  '@/components/Sidebar': 'export function Sidebar(){return null}',
  '@/features/suppliers/supplierApi': 'export const supplierApi=fixture.suppliers',
  '@/features/suppliers/LabelPrintModal': 'export function LabelPrintModal(){return null}',
  '@/features/orders/orderApi': 'export const orderApi=fixture.orders',
  '@/features/customers/customerApi': 'export const customerApi=fixture.customers',
  '@/features/products/productApi': 'export const productApi={get:async()=>({data:{}})};export function requestDesktopSync(){throw Error("Unexpected sync request")}',
  '@/features/pos/saleApi': 'export const saleApi=fixture.sales',
  '@/features/pos/shiftApi': 'export const shiftApi={current:async()=>({data:null})}',
  '@/features/pos/cashOperationApi': 'export const cashOperationApi={create:()=>{throw Error("Unexpected financial write")}}',
  '@/lib/api': 'export const api=fixture.api',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>({pos:{createCashOperation:()=>{throw Error("Unexpected financial write")}}});export const isDesktopRuntime=()=>true',
  '@/stores/authStore': 'export const useAuthStore=Object.assign(select=>select(fixture.auth),{getState:()=>fixture.auth})',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
}
const entry = `
import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useLocation,useNavigate}from'react-router-dom';
import{useViewNavigation}from'/src/hooks/useViewNavigation.ts';
import Suppliers from'/src/features/suppliers/SuppliersPage.tsx';import Supplier from'/src/features/suppliers/SupplierDetailPage.tsx';import SupplierForm from'/src/features/suppliers/SupplierFormPage.tsx';
import Invoices from'/src/features/suppliers/InvoicesPage.tsx';import Invoice from'/src/features/suppliers/InvoiceDetailPage.tsx';
import Orders from'/src/features/orders/OrdersPage.tsx';import Order from'/src/features/orders/OrderDetailPage.tsx';
import Sales from'/src/features/sales/SalesPage.tsx';import Waitlist from'/src/features/waitlist/WaitlistPage.tsx';import Needs from'/src/features/orders/NeedsActionPage.tsx';import Cashflow from'/src/features/cashflow/CashflowPage.tsx';import'/src/index.css';
function Destination(){const{back}=useViewNavigation('/');return <><p>Test destination</p><button onClick={back}>Test back</button></>}
function App(){const location=useLocation(),navigate=useNavigate();fixture.go=navigate;return <><output data-testid="route">{location.pathname+location.search}</output><Routes>
<Route path='/suppliers' element={<Suppliers/>}/><Route path='/suppliers/:id' element={<Supplier/>}/><Route path='/suppliers/:id/edit' element={<SupplierForm/>}/>
<Route path='/suppliers/invoices' element={<Invoices/>}/><Route path='/suppliers/invoices/:id' element={<Invoice/>}/><Route path='/suppliers/invoices/:id/edit' element={<Destination/>}/><Route path='/suppliers/invoices/new' element={<Destination/>}/>
<Route path='/orders' element={<Orders/>}/><Route path='/orders/:id' element={<Order/>}/><Route path='/sales' element={<Sales/>}/><Route path='/waitlist' element={<Waitlist/>}/><Route path='/needs-action' element={<Needs/>}/><Route path='/cashflow' element={<Cashflow/>}/><Route path='*' element={<Destination/>}/>
</Routes></>};createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[fixture.start]}><App/></MemoryRouter>);
`
const bootstrap = `
window.fixture={start:window.testStart,reads:[],writes:[],errors:[],warnings:[],messages:[],auth:{offlineMode:false,session:{user:{id:'test-owner',app_metadata:{role:'owner'}}}}};
fixture.supplier={id:'supplier-a',name:'Synthetic supplier',phone:'000',email:'',contact_name:'Contact',notes:'',is_active:true};
fixture.invoice=id=>({id,invoice_number:id,status:id==='draft'?'draft':id==='cancelled'?'cancelled':'posted',supplier_id:'supplier-a',supplier:fixture.supplier,total:10000,paid_amount:0,created_at:'2026-10-12T08:00:00Z',items:[]});
fixture.page=(data,page=1,pages=2)=>({data,pagination:{page,total:21,total_pages:pages,per_page:20}});
fixture.suppliers={
 list:async params=>{fixture.reads.push({kind:'suppliers',...params});return fixture.page([fixture.supplier],params.page)},
 get:async()=>({data:fixture.supplier}),update:async(id,body)=>{fixture.writes.push({kind:'supplier-update',id,body});Object.assign(fixture.supplier,body);return{data:fixture.supplier}},
 listInvoices:async params=>{fixture.reads.push({kind:'invoices',...params});return fixture.page(['draft','posted','cancelled'].map(fixture.invoice),params.page,1)},getInvoice:async id=>({data:fixture.invoice(id)}),
};
fixture.order={id:'order-a',order_number:77,status:'completed',source:'walk_in',total_amount:10000,total_paid:10000,prepayment:0,created_at:'2026-10-12T08:00:00Z',updated_at:'v1',items:[],customer:{id:'customer-a',full_name:'Target customer',phone:'000'},vehicle_info:null,comment:null};
fixture.queueOrders=[{id:'walk',status:'lead',source:'walk_in',items:[]},{id:'mobile',status:'lead',source:'mobile_draft',items:[]},{id:'quote',status:'quoted',items:[]},{id:'ready',status:'ready',items:[]},{id:'arrived',status:'arrived',items:[]},{id:'called',status:'called',items:[]},{id:'noanswer',status:'no_answer',items:[]}];
fixture.orders={list:async(offset,opts,limit,filters)=>{fixture.reads.push({kind:'orders',offset,limit,...filters});const queue=location.pathname.includes('unused')||fixture.start==='/needs-action';return queue?{data:fixture.queueOrders.slice(offset,offset+4),meta:{has_more:offset===0}}:{data:[fixture.order],meta:{has_more:offset===0}}},get:async()=>({data:fixture.order}),listPayments:async()=>({data:[]})};
fixture.customers={get:async()=>({data:fixture.order.customer}),list:async params=>{fixture.reads.push({kind:'customers',...params});return {data:[{id:'debtor-'+params.page,debt_balance:1000}],pagination:{page:params.page,total_pages:2,total:2,per_page:100}}}};
fixture.waiting={id:'waiting-a',customer_id:'customer-a',product_id:'product-a',status:'waiting',created_at:'2026-10-12T08:00:00Z',product:{id:'product-a',name:'Synthetic product',sku:'SKU',retail_price:10000,qty_on_hand:2},customer:{id:'customer-a',full_name:'Target customer',phone:'000'}};
fixture.api={get:async url=>{if(url==='/api/v1/waitlist')return{data:[fixture.waiting]};throw Error('Unexpected API read '+url)},post:()=>{throw Error('Unexpected API write')},delete:()=>{throw Error('Unexpected API write')}};
fixture.sale={id:'sale-a',sale_number:'S-77',total:10000,discount:0,status:'completed',sync_status:'synced',payment_method:'cash',completed_at:'2026-10-12T08:00:00Z',customer:fixture.order.customer,sale_items:[],returns:[]};
fixture.sales={list:async params=>{fixture.reads.push({kind:'sales',...params});return fixture.page([fixture.sale],params.page)},get:async()=>({data:fixture.sale})};
`
const server = await createServer({ cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',optimizeDeps:{entries:[]},esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'workflow-navigation-fixtures',enforce:'pre',resolveId(id){if(id==='virtual:navigation.tsx'||Object.hasOwn(mocks,id))return'\0'+id},
  async load(id){if(id==='\0virtual:navigation.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(vite){vite.middlewares.use('/navigation-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await vite.transformIndexHtml('/navigation-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:navigation.tsx"></script></body></html>'))})},
}]})
let browser
try {
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[],blocked=[]
  async function setup(start){const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('dialog',d=>d.accept());await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()));await page.addInitScript(start=>{window.testStart=start},start);await page.goto(base+'navigation-test',{timeout:30000});return page}
  const route=(page,value)=>page.waitForFunction(value=>document.querySelector('[data-testid=route]')?.textContent===value,value)
  const back=page=>page.getByRole('button',{name:'Test back',exact:true}).click()
  const waitRead=(page,kind,field,value)=>page.waitForFunction(({kind,field,value})=>fixture.reads.some(row=>row.kind===kind&&row[field]===value),{kind,field,value})

  const supplier=await setup('/suppliers')
  await supplier.getByPlaceholder('Пошук за назвою, контактом...').fill('Synthetic')
  await waitRead(supplier,'suppliers','search','Synthetic');await supplier.getByRole('button',{name:'→',exact:true}).click();await waitRead(supplier,'suppliers','page',2)
  await supplier.getByRole('button',{name:'Synthetic supplier',exact:true}).click();await route(supplier,'/suppliers/supplier-a')
  await supplier.getByRole('button',{name:'posted',exact:true}).click();await route(supplier,'/suppliers/invoices/posted')
  await supplier.getByText('Борг постачальнику:').waitFor();await back(supplier);await route(supplier,'/suppliers/supplier-a')
  await supplier.getByRole('button',{name:'Редагувати',exact:true}).click();await supplier.getByLabel('Назва *').fill('Edited supplier')
  await supplier.getByRole('button',{name:'Зберегти',exact:true}).click();await route(supplier,'/suppliers/supplier-a')
  await back(supplier);await route(supplier,'/suppliers');await supplier.getByRole('button',{name:'Edited supplier',exact:true}).waitFor()
  assert.equal(await supplier.getByPlaceholder('Пошук за назвою, контактом...').inputValue(),'Synthetic')
  assert.equal(await supplier.evaluate(()=>fixture.reads.filter(r=>r.kind==='suppliers').at(-1).page),2)
  assert.equal(await supplier.evaluate(()=>fixture.writes.length),1);assert.deepEqual(await supplier.evaluate(()=>fixture.errors),[]);await supplier.close()

  const invoices=await setup('/suppliers/invoices')
  await invoices.getByTitle('Редагувати чернетку').click();await route(invoices,'/suppliers/invoices/draft/edit');await back(invoices)
  await invoices.getByRole('row').filter({hasText:'posted'}).getByTitle('Переглянути накладну').click();await route(invoices,'/suppliers/invoices/posted')
  assert.equal(await invoices.getByRole('button',{name:'Редагувати',exact:true}).count(),0)
  await invoices.getByRole('button',{name:'Скасувати і редагувати копію',exact:true}).waitFor();await back(invoices)
  await invoices.getByRole('heading',{name:/Приходні накладні/}).waitFor()
  assert.equal(await invoices.getByRole('button',{name:'Test back',exact:true}).count(),0,'Invoice list no longer returns into receiving hub')
  assert.equal(await invoices.evaluate(()=>fixture.writes.length),0);await invoices.close()

  const orders=await setup('/orders')
  await orders.getByRole('button',{name:'Виконані',exact:true}).click();await orders.getByPlaceholder('Пошук: № замовлення, клієнт, телефон, авто…').fill('Target')
  await waitRead(orders,'orders','search','Target');await orders.getByRole('button',{name:'Наступна сторінка',exact:true}).click();await waitRead(orders,'orders','offset',50)
  await orders.getByRole('button',{name:'Відкрити',exact:true}).click();await orders.getByRole('button',{name:'Test back',exact:true}).waitFor();await back(orders)
  await orders.getByRole('button',{name:'Відкрити',exact:true}).waitFor()
  assert.equal(await orders.getByPlaceholder('Пошук: № замовлення, клієнт, телефон, авто…').inputValue(),'Target')
  assert.deepEqual(await orders.evaluate(()=>{const r=fixture.reads.filter(r=>r.kind==='orders').at(-1);return{offset:r.offset,status:r.status,search:r.search}}),{offset:50,status:'completed,archived',search:'Target'})
  await orders.evaluate(()=>fixture.go('/orders?tab=ready&search='));await waitRead(orders,'orders','status','ready,arrived,called,no_answer')
  assert.equal(await orders.getByPlaceholder('Пошук: № замовлення, клієнт, телефон, авто…').inputValue(),'')
  assert.equal(await orders.evaluate(()=>fixture.writes.length),0);await orders.close()

  const sales=await setup('/sales');await sales.getByPlaceholder("Пошук за чеком, телефоном або ім'ям клієнта...").fill('S-77')
  await waitRead(sales,'sales','search','S-77');await sales.getByRole('button',{name:'→',exact:true}).click();await waitRead(sales,'sales','page',2)
  await sales.getByRole('button',{name:'#S-77',exact:true}).click();await sales.getByRole('button',{name:'Оформити повернення',exact:true}).click();await route(sales,'/returns?sale=S-77');await back(sales)
  await sales.getByRole('button',{name:'#S-77',exact:true}).waitFor();assert.equal(await sales.getByPlaceholder("Пошук за чеком, телефоном або ім'ям клієнта...").inputValue(),'S-77')
  assert.equal(await sales.evaluate(()=>fixture.reads.filter(r=>r.kind==='sales').at(-1).page),2);await sales.close()

  const waitlist=await setup('/waitlist');assert.equal(await waitlist.getByRole('link',{name:'Target customer',exact:true}).getAttribute('href'),'/customers/customer-a');assert.equal(await waitlist.getByRole('link',{name:'Synthetic product',exact:true}).getAttribute('href'),'/products/product-a');await waitlist.close()
  const cash=await setup('/cashflow');await cash.getByRole('link',{name:'«Каса»',exact:true}).click();await route(cash,'/pos');assert.equal(await cash.evaluate(()=>fixture.writes.length),0);await cash.close()
  const needs=await setup('/needs-action');await needs.getByRole('button',{name:/Борги клієнтів/}).waitFor()
  for(const[label,count]of[['До видачі (незабрані)',4],['Чернетки / КП',2],['Ліди',1],['Борги клієнтів',2]]){
    const card=needs.getByRole('button').filter({hasText:label});assert.equal(await card.locator('span.text-2xl').innerText(),String(count))
  }
  await needs.getByRole('button',{name:/Борги клієнтів/}).click();await route(needs,'/customers?has_debt=true');assert.equal(await needs.evaluate(()=>fixture.writes.length),0);await needs.close()
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: 7 actual-page navigation scenarios: supplier list/detail/invoice/edit nested return + retained search/page; draft-only invoice edit + posted safeguards; order tab/search/page retention and explicit cleared queue; sales search/page retained across return destination; waitlist existing-card links; closed-shift POS hint; paged exact action counters and debtor route. Editor/return destination stubs verify navigation only, not money or document transactions. No live data/external traffic.')
}finally{await browser?.close();await server.close()}
