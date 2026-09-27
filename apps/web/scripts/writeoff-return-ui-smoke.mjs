// Real React forms and durable return API. All documents, accounts and transports are synthetic.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const mocks={
  '@/lib/desktopBridge':'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>true',
  '@/lib/api':'export const api={get:async()=>{throw Error("Live API forbidden")},post:async()=>{throw Error("Live API forbidden")}}',
  '@/stores/authStore':'const state={session:{user:{id:"cashier",app_metadata:{role:"owner",tenant_id:"test"}}}};export const useAuthStore=Object.assign(s=>s(state),{getState:()=>state})',
  '@/features/pos/saleApi':'export const saleApi={list:async params=>new Promise(resolve=>fixture.searches[params.search||params.product_barcode]=resolve),get:async()=>{throw Error("Unexpected sale get")}}',
  '@/features/orders/orderApi':'export const orderApi={}',
  '@/features/pos/usePOSBarcodeScanner':'export const usePOSBarcodeScanner=()=>{}',
  '@/features/inventory/writeoffApi':'export const writeoffApi={create:body=>{fixture.writeoffs.push(body);return new Promise((resolve,reject)=>{fixture.finishWriteoff=()=>resolve({data:{id:"w"}});fixture.failWriteoff=reject})},checkOperation:async()=>{if(fixture.lookupFails)throw Error("No reply");return fixture.savedWriteoff}}',
  '@/components/ProductAutocomplete':'export function ProductAutocomplete({onSelect}){return <button type="button" onClick={()=>onSelect({id:"p",name:"Тестова олива",sku:"OIL",unit:"л",qty_on_hand:100})}>Додати тестову оливу</button>}',
  '@/components/Layout':'export function Layout({children,title,actions,onBack}){return <main><h1>{title}</h1>{actions}{onBack&&<button onClick={onBack}>Назад тест</button>}{children}</main>}',
  '@/components/ui/Toast':'export function ToastContainer(){return null} export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)}',
}
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,useLocation} from 'react-router-dom';
import ReturnForm from '/src/features/pos/ReturnForm.tsx';import WriteoffFormPage from '/src/features/inventory/WriteoffFormPage.tsx';
function App(){const location=useLocation();return <><p data-testid="location">{location.pathname}</p>{window.location.search.includes('writeoff')?<WriteoffFormPage/>:<ReturnForm/>}</>}
createRoot(document.getElementById('root')).render(<MemoryRouter><App/></MemoryRouter>);`
const bootstrap=`window.fixture={errors:[],warnings:[],messages:[],writeoffs:[],returns:[],searches:{},lookupFails:false,savedReturn:null,savedWriteoff:null};
fixture.sale=id=>({id,sale_number:id,total:2500,status:'completed'});
fixture.bridge={pos:{getOpenShift:async()=>({id:'shift'}),getSaleForReturn:async id=>({sale:{id,fiscal_number:null},items:[{id:'line-'+id,product_id:'p-'+id,product_name:'Олива '+id,sku:id,unit:'л',qty:2.5,unit_price:1000,available_qty:2.5,available_refund:2500,refundable_total:2500,already_returned_qty:0}]}),
createReturn:body=>{fixture.returns.push(body);return new Promise((resolve,reject)=>{fixture.finishReturn=()=>resolve({id:'r',sale_id:body.sale_id,refund_kopecks:1500,refund_method:'cash',stock_action:'return_to_stock',return_items:body.items});fixture.failReturn=reject})},
getReturnByOperation:async()=>{if(fixture.lookupFails)throw Error('No reply');return fixture.savedReturn}},fiscal:{listUnresolvedReturns:async()=>{if(fixture.fiscalFails)throw Error('Fiscal journal unavailable');return []}}};fixture.fiscalFails=location.search.includes('startup-error');`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'stock-form-fixture',enforce:'pre',resolveId(id){if(id==='virtual:stock-form.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:stock-form.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const [name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/stock-form-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/stock-form-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:stock-form.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[]
  const page=await browser.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('console',m=>{if(m.type()==='error')console.error(m.text())});page.on('dialog',d=>d.accept())
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort())
  const reset=async kind=>{await page.goto(base+'stock-form-test?'+kind);await page.evaluate(()=>localStorage.clear());await page.reload()}
  await reset('return')
  const search=page.getByPlaceholder("Номер чека, телефон, ім'я або штрихкод товару")
  await search.fill('A');await page.getByRole('button',{name:'Знайти',exact:true}).click()
  await search.fill('B');await search.evaluate(e=>e.form.requestSubmit())
  await page.waitForFunction(()=>fixture.searches.B)
  await page.evaluate(()=>fixture.searches.B({data:[fixture.sale('B')]}))
  await page.getByLabel('Кількість повернення: Олива B',{exact:true}).waitFor()
  await page.evaluate(()=>fixture.searches.A({data:[fixture.sale('A')]}))
  assert.equal(await page.getByLabel('Кількість повернення: Олива A',{exact:true}).count(),0)
  await page.getByLabel('Кількість повернення: Олива B',{exact:true}).fill('1.5')
  await page.getByRole('button',{name:/Далі: Причина і оплата/}).click()
  assert.match(await page.getByRole('button',{name:/Оформити повернення на/}).innerText(),/15[,.]00/)
  await page.getByRole('button',{name:/Оформити повернення на/}).evaluate(button=>{button.form.requestSubmit();button.form.requestSubmit()})
  await page.waitForFunction(()=>fixture.returns.length===1)
  assert.equal(await search.isDisabled(),true)
  assert.equal(await page.evaluate(()=>fixture.returns[0].items[0].quantity),1.5)
  assert.equal(await page.evaluate(()=>fixture.returns[0].sale_id),'B')
  // Lost reply + failed status query: reopen only allows a read-only check.
  await page.evaluate(()=>{fixture.lookupFails=true;fixture.failReturn(Error('Reply lost'))})
  await page.getByRole('button',{name:'Перевірити повернення',exact:true}).waitFor()
  await page.reload()
  assert.equal(await search.isDisabled(),true)
  await page.evaluate(()=>{fixture.savedReturn={id:'r',refund_kopecks:1500,refund_method:'cash',stock_action:'return_to_stock',return_items:[{}]}})
  await page.getByRole('button',{name:'Перевірити повернення',exact:true}).click()
  await page.getByText('Повернення оформлено',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.returns.length),0)
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('forsage:return-attempt:')).length),0)
  await reset('writeoff')
  await page.getByRole('button',{name:'Додати тестову оливу',exact:true}).click()
  const qty=page.getByLabel('Кількість списання: Тестова олива',{exact:true})
  await qty.fill('98');await page.reload();assert.equal(await qty.inputValue(),'98')
  await page.locator('#writeoff-form').evaluate(form=>{form.requestSubmit();form.requestSubmit()})
  await page.waitForFunction(()=>fixture.writeoffs.length===1)
  assert.equal(await qty.isDisabled(),true)
  assert.equal(await page.evaluate(()=>fixture.writeoffs[0].items[0].qty),98)
  await page.evaluate(()=>{fixture.lookupFails=true;fixture.failWriteoff(Error('Lost reply'))})
  await page.getByRole('button',{name:'Перевірити списання',exact:true}).waitFor()
  await page.reload();assert.equal(await qty.isDisabled(),true)
  await page.getByRole('button',{name:'Закрити',exact:true}).first().click()
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('forsage:writeoff-draft:')).length),1)
  await page.evaluate(()=>{fixture.savedWriteoff={id:'w'}})
  await page.getByRole('button',{name:'Перевірити списання',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-testid=location]').textContent==='/inventory/writeoffs/w')
  assert.equal(await page.evaluate(()=>fixture.writeoffs.length),0)
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('forsage:writeoff-draft:')).length),0)
  await reset('writeoff');await page.evaluate(()=>localStorage.setItem('forsage:writeoff-draft:cashier','broken'));await page.reload()
  await page.getByRole('alert').filter({hasText:'прочитати чернетку'}).waitFor()
  assert.equal(await page.evaluate(()=>localStorage.getItem('forsage:writeoff-draft:cashier')),'broken')
  // A failed transaction with confirmed absence unlocks the same draft, not a replacement document.
  await reset('writeoff')
  await page.getByRole('button',{name:'Додати тестову оливу',exact:true}).click()
  await qty.fill('1.5');await page.locator('#writeoff-form').evaluate(form=>form.requestSubmit())
  await page.waitForFunction(()=>fixture.writeoffs.length===1)
  await page.evaluate(()=>fixture.failWriteoff(Error('Insufficient stock')))
  await page.waitForFunction(()=>document.querySelector('[aria-label="Кількість списання: Тестова олива"]')?.disabled===false && !document.querySelector('fieldset')?.disabled)
  assert.equal(await qty.inputValue(),'1.5')
  assert.equal(await page.getByRole('button',{name:'Перевірити списання',exact:true}).count(),0)
  assert.equal(await page.evaluate(()=>fixture.writeoffs.length),1)
  // When fiscal recovery cannot be read, no new return may be sent until a successful recheck.
  await reset('return-startup-error')
  await page.getByRole('button',{name:'Перевірити попередні повернення',exact:true}).waitFor()
  assert.equal(await search.isDisabled(),true)
  await page.evaluate(()=>{fixture.fiscalFails=false})
  await page.getByRole('button',{name:'Перевірити попередні повернення',exact:true}).click()
  await page.waitForFunction(()=>!document.querySelector('fieldset')?.disabled)
  assert.equal(await search.isDisabled(),false)
  assert.equal(await page.evaluate(()=>fixture.returns.length),0)
  assert.deepEqual(errors,[])
  console.log('PASS: stale receipt search ignored; 1.5 L and refund retained; double submits locked; uncertain return and writeoff survive reload; status checks never repeat writes; draft 98 preserved; corrupt draft blocked; rollback unlocks original draft; fiscal recovery fails closed')
}finally{await browser?.close();await server.close()}
