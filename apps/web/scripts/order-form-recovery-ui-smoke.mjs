// Actual order form; all services and storage belong to isolated browser contexts.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const {default:tailwindcss}=await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const mocks={
  '@/features/orders/orderApi':'export const orderApi=window.fixture.orders',
  '@/features/products/productApi':'export const productApi={search:async()=>({data:[]})}',
  '@/features/customers/customerApi':'export const customerApi=window.fixture.customers',
  '@/features/customers/customerVehiclesApi':'export const customerVehiclesApi=window.fixture.vehicles',
  '@/features/suppliers/supplierApi':'export const supplierApi={list:async()=>({data:[]})}',
  '@/features/admin/adminApi':'export const adminApi={getSettings:async()=>({data:{quick_percents:[]}})}',
  '@/features/admin/pricingApi':'export const pricingApi={autoRetail:()=>new Promise(resolve=>fixture.resolvePrice=resolve)}',
  '@/lib/api':'export const api={get:()=>new Promise((resolve,reject)=>fixture.vinRequests.push({resolve,reject}))}',
  '@/lib/vehicleOcr':'export const recognizeVehicleImage=()=>new Promise((resolve,reject)=>fixture.photoRequests.push({resolve,reject}))',
  '@/stores/authStore':'export const useAuthStore=select=>select({session:{user:{id:"staff",app_metadata:{tenant_id:"test"}}}})',
  '@/components/ui/Toast':'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout':'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
}
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useLocation}from'react-router-dom';import Form from '/src/features/orders/OrderFormPage.tsx';import '/src/index.css';function Location(){return <div data-testid="location">{useLocation().pathname}</div>}createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[fixture.route]}><Location/><Routes><Route path='/orders/new' element={<Form/>}/><Route path='/orders/:id/edit' element={<Form/>}/><Route path='*' element={<p>Saved destination</p>}/></Routes></MemoryRouter>);`
const bootstrap=`
window.forsageDesktop={};window.fixture={errors:[],warnings:[],messages:[],writes:[],lookups:[],photoRequests:[],vinRequests:[],mode:window.testMode??'normal',route:window.testRoute??'/orders/new'};
const a={id:'a',full_name:'Перший клієнт',phone:'111',debt_balance:0},b={id:'b',full_name:'Другий клієнт',phone:'222',debt_balance:0};
fixture.base={id:'order',status:'lead',updated_at:'r1',customer_id:'a',customer:a,vehicle_info:{make:'Old',model:'Original',vin:'OLDVIN'},total:10000,total_paid:0,items:[{id:'line',name:'Фільтр тестовий',sku:'W67',qty:2,sell_price:5000,buy_price:3000,source_type:'supplier',item_status:'pending',item_type:'product'}]};
fixture.customers={list:async()=>({data:[a,b]}),get:id=>new Promise(resolve=>fixture.resolveCustomer=()=>resolve({data:id==='a'?a:b}))};
fixture.vehicles={list:id=>id==='a'?new Promise(resolve=>fixture.resolveOldVehicle=()=>resolve({data:[{id:'old',customer_id:'a',brand:'Old',model:'Original',vin:'OLDVIN'}]})):Promise.resolve({data:[{id:'new',customer_id:'b',brand:'New',model:'Current',vin:'NEWVIN'}]})};
fixture.orders={get:async()=>({data:structuredClone(fixture.base)}),create:body=>fixture.save(undefined,body),update:(id,body)=>fixture.save(id,body),updateStatus:async()=>{throw Error('Unexpected activation')},getSaveResult:async(op,id)=>{fixture.lookups.push({op,id});if(fixture.mode==='offline')throw Error('Hub unavailable');return JSON.parse(localStorage.getItem('test:saved')??'null')}};
fixture.save=async(id,body)=>{fixture.writes.push({id,body});await new Promise(r=>setTimeout(r,40));if(fixture.mode==='conflict')throw Error('Замовлення змінив інший працівник');if(fixture.mode==='offline')throw Error('Reply unavailable');const saved={...fixture.base,...body,id:id??'created',updated_at:'r2'};localStorage.setItem('test:saved',JSON.stringify(saved));if(fixture.mode==='lost')throw Error('Reply lost');return {data:saved}};
fixture.key='forsage:order-form:v1:test:staff:'+(fixture.route.includes('/edit')?'order':'new')+':';
if(!localStorage.getItem('test:seeded')){localStorage.setItem('test:seeded','1');if(window.testCorrupt)localStorage.setItem(fixture.key,'broken');else if(!fixture.route.includes('/edit'))localStorage.setItem(fixture.key,JSON.stringify({version:1,data:{items:[{name:'Фільтр тестовий',sku:'W67',qty:'2',sell_price:'50',buy_price:'30',supplier_id:'',source_type:'supplier'}],step:3}}));}
if(fixture.mode==='vehicle') {const draft=JSON.parse(localStorage.getItem(fixture.key));Object.assign(draft.data,{step:2,selectedCustomer:a,customerId:'a',showAddVehicle:true,newVehVin:'WVWZZZ1JZXW000001',newVehBrand:'Volkswagen',newVehModel:'Original',newVehYear:'2001',loadedVehicleInfo:{make:'Before',model:'Photo',vin:'BEFOREPHOTO'}});localStorage.setItem(fixture.key,JSON.stringify(draft));}
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'order-recovery-fixture',enforce:'pre',resolveId(id){if(id==='virtual:order-recovery.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:order-recovery.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/order-recovery-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/order-recovery-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:order-recovery.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[],blocked=[]
  async function setup(mode='normal',route='/orders/new',corrupt=false){
    const page=await browser.newPage({viewport:{width:1400,height:1000}})
    page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)})
    await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()))
    await page.addInitScript(({mode,route,corrupt})=>{window.testMode=mode;window.testRoute=route;window.testCorrupt=corrupt},{mode,route,corrupt})
    await page.goto(base+'order-recovery-test')
    if(corrupt)await page.getByRole('alert').waitFor();else await page.getByLabel('Кількість',{exact:true}).waitFor()
    return page
  }
  const save=p=>p.getByRole('button',{name:/^(Зберегти чернетку|Зберегти зміни)$/})
  const waitSaved=p=>p.waitForFunction(()=>document.querySelector('[data-testid=location]').textContent==='/orders/created'||document.querySelector('[data-testid=location]').textContent==='/orders/order')
  const durable=await setup()
  await durable.getByLabel('Кількість',{exact:true}).fill('98')
  await durable.waitForFunction(()=>JSON.parse(localStorage.getItem(fixture.key)).data.items[0].qty==='98')
  await durable.evaluate(()=>sessionStorage.clear());await durable.reload()
  assert.equal(await durable.getByLabel('Кількість',{exact:true}).inputValue(),'98')
  await save(durable).evaluate(button=>{button.click();button.click()});await waitSaved(durable)
  assert.deepEqual(await durable.evaluate(()=>fixture.writes.map(w=>w.body.items[0].qty)),[98])
  assert.equal(await durable.evaluate(()=>localStorage.getItem(fixture.key)),null);await durable.close()
  const lost=await setup('lost');await save(lost).click();await waitSaved(lost)
  assert.equal(await lost.evaluate(()=>fixture.writes.length),1);assert.equal(await lost.evaluate(()=>fixture.lookups.length),1);await lost.close()
  const offline=await setup('offline');await offline.getByLabel('Кількість',{exact:true}).fill('7');await save(offline).click()
  await offline.waitForFunction(()=>fixture.lookups.length===1)
  assert.equal(await offline.getByLabel('Кількість',{exact:true}).isDisabled(),true)
  await offline.evaluate(()=>sessionStorage.clear());await offline.reload()
  await offline.getByRole('button',{name:'Перевірити збереження',exact:true}).waitFor()
  assert.equal(await offline.getByLabel('Кількість',{exact:true}).inputValue(),'7')
  assert.equal(await offline.getByLabel('Кількість',{exact:true}).isDisabled(),true)
  await offline.evaluate(()=>{fixture.mode='normal';localStorage.setItem('test:saved',JSON.stringify({...fixture.base,id:'created'}))})
  await offline.getByRole('button',{name:'Перевірити збереження',exact:true}).click();await waitSaved(offline)
  assert.equal(await offline.evaluate(()=>fixture.writes.length),0);await offline.close()
  const absent=await setup('offline');await save(absent).click();await absent.waitForFunction(()=>fixture.lookups.length===1)
  await absent.evaluate(()=>fixture.mode='normal');await absent.getByRole('button',{name:'Перевірити збереження',exact:true}).click()
  await absent.waitForFunction(()=>!document.querySelector('fieldset').disabled)
  assert.equal(await absent.getByLabel('Кількість',{exact:true}).inputValue(),'2')
  await save(absent).click();await waitSaved(absent);assert.equal(await absent.evaluate(()=>fixture.writes.length),2);await absent.close()
  const corrupt=await setup('normal','/orders/new',true)
  assert.match(await corrupt.getByRole('alert').innerText(),/не перезаписано/)
  assert.equal(await corrupt.evaluate(()=>localStorage.getItem(fixture.key)),'broken');assert.equal(await corrupt.evaluate(()=>fixture.writes.length),0);await corrupt.close()
  const edit=await setup('normal','/orders/order/edit')
  await edit.getByRole('button',{name:'Змінити',exact:true}).first().click()
  await edit.getByRole('button',{name:/Другий клієнт/}).click()
  await edit.waitForFunction(()=>document.body.textContent.includes('New Current'))
  await edit.evaluate(()=>{fixture.resolveCustomer();fixture.resolveOldVehicle()})
  await edit.getByLabel('Кількість',{exact:true}).fill('5');await save(edit).click();await waitSaved(edit)
  assert.deepEqual(await edit.evaluate(()=>fixture.writes.map(w=>({customer:w.body.customer_id,vin:w.body.vehicle_info.vin,version:w.body.expected_updated_at,qty:w.body.items[0].qty}))),[{customer:'b',vin:'NEWVIN',version:'r1',qty:5}]);await edit.close()
  const conflict=await setup('conflict','/orders/order/edit');await conflict.getByLabel('Кількість',{exact:true}).fill('11');await save(conflict).click()
  await conflict.waitForFunction(()=>fixture.errors.some(e=>e.includes('інший працівник')))
  assert.equal(await conflict.getByLabel('Кількість',{exact:true}).inputValue(),'11');await conflict.reload()
  assert.equal(await conflict.getByLabel('Кількість',{exact:true}).inputValue(),'11')
  assert.equal(await conflict.evaluate(()=>JSON.parse(localStorage.getItem(fixture.key)).data.loadedOrderVersion),'r1');await conflict.close()
  const price=await setup()
  await price.getByLabel('Націнка позиції 1',{exact:true}).selectOption('table')
  await price.waitForFunction(()=>typeof fixture.resolvePrice==='function')
  await price.getByLabel('Продаж, грн',{exact:true}).fill('75')
  await price.evaluate(()=>fixture.resolvePrice({data:{retail_price:9000}}))
  await save(price).click();await waitSaved(price)
  assert.equal(await price.evaluate(()=>fixture.writes[0].body.items[0].sell_price),7500);await price.close()
  const vehicle=await setup('vehicle')
  const photo=p=>p.locator('input[type=file]').setInputFiles({name:'vin.png',mimeType:'image/png',buffer:Buffer.from('mock photo')})
  const decode=p=>p.getByRole('button',{name:/Декодувати/})
  await photo(vehicle);await vehicle.waitForFunction(()=>fixture.photoRequests.length===1)
  await vehicle.getByLabel('Модель',{exact:true}).fill('Manually corrected')
  await vehicle.evaluate(()=>fixture.photoRequests[0].resolve({vin:'OTHER',make:'Wrong',model:'Stale',year:1990}))
  await vehicle.waitForTimeout(150)
  assert.equal(await vehicle.getByLabel('Модель',{exact:true}).inputValue(),'Manually corrected','late photo must not replace manual model')
  assert.equal(await vehicle.getByLabel('VIN-код (17 знаків)').inputValue(),'WVWZZZ1JZXW000001')
  await save(vehicle).click();await waitSaved(vehicle)
  assert.equal(await vehicle.evaluate(()=>fixture.writes[0].body.vehicle_info.model),'Manually corrected')
  await vehicle.close()
  // A later photo wins even when earlier recognition completes/errors out of order.
  const latest=await setup('vehicle')
  await photo(latest);await photo(latest);await latest.waitForFunction(()=>fixture.photoRequests.length===2)
  await latest.evaluate(()=>fixture.photoRequests[0].reject(Error('obsolete photo error')))
  await latest.waitForTimeout(100)
  assert.equal(await latest.getByText('Розпізнавання…',{exact:true}).count(),1)
  assert.equal(await latest.evaluate(()=>fixture.errors.length),0)
  await latest.evaluate(()=>fixture.photoRequests[1].resolve({vin:'WVWZZZ1JZXW000002',make:'Confirmed brand',model:'New photo',year:2015}))
  await latest.waitForFunction(()=>document.querySelector('input[placeholder="Rio"]').value==='New photo')
  assert.equal(await latest.getByLabel('Марка / Бренд').inputValue(),'Confirmed brand','VIN prefix hint must not replace recognized brand')
  await latest.getByLabel('Модель',{exact:true}).fill('After OCR correction')
  await latest.getByLabel('Рік випуску').fill('2016')
  await save(latest).click();await waitSaved(latest)
  assert.deepEqual(await latest.evaluate(()=>fixture.writes[0].body.vehicle_info),{vin:'WVWZZZ1JZXW000002',make:'Confirmed brand',model:'After OCR correction',year:2016})
  await latest.close()
  const outOfOrder=await setup('vehicle')
  await photo(outOfOrder);await photo(outOfOrder)
  await outOfOrder.waitForFunction(()=>fixture.photoRequests.length===2)
  await outOfOrder.evaluate(()=>fixture.photoRequests[1].resolve({vin:'CURRENTVIN',make:'Current',model:'Latest'}))
  await outOfOrder.waitForFunction(()=>document.querySelector('input[placeholder="Rio"]').value==='Latest')
  await outOfOrder.evaluate(()=>fixture.photoRequests[0].resolve({vin:'STALEVIN',make:'Old',model:'Obsolete'}))
  await outOfOrder.waitForTimeout(100)
  assert.equal(await outOfOrder.getByLabel('Модель',{exact:true}).inputValue(),'Latest');await outOfOrder.close()
  // Every manually edited vehicle field invalidates in-flight decoding, including edit-and-revert.
  for(const [label,value]of [['VIN-код (17 знаків)','WVWZZZ1JZXW000003'],['Марка / Бренд','Manual brand'],['Модель','Manual model'],['Рік випуску','2020']]){
    const edited=await setup('vehicle');await decode(edited).click();await edited.waitForFunction(()=>fixture.vinRequests.length===1)
    await edited.getByLabel(label,{exact:true}).fill(value)
    await edited.evaluate(()=>fixture.vinRequests[0].resolve({data:{make:'Stale make',model:'Stale model',year:'1990'}}))
    await edited.waitForTimeout(100);assert.equal(await edited.getByLabel(label,{exact:true}).inputValue(),value)
    assert.equal(await edited.getByLabel('Модель',{exact:true}).inputValue(),label==='Модель'?value:'Original')
    assert.equal(await decode(edited).isDisabled(),false);await edited.close()
  }
  // Cancel suppresses stale errors and successful OCR does not replace the chosen car until saved.
  const cancelled=await setup('vehicle');await photo(cancelled);await cancelled.waitForFunction(()=>fixture.photoRequests.length===1)
  await cancelled.getByRole('button',{name:'Скасувати',exact:true}).click()
  await cancelled.evaluate(()=>fixture.photoRequests[0].reject(Error('late cancelled error')))
  await cancelled.waitForTimeout(100);assert.equal(await cancelled.evaluate(()=>fixture.errors.length),0)
  await cancelled.getByRole('button',{name:'Додати новий автомобіль'}).click();await photo(cancelled)
  await cancelled.waitForFunction(()=>fixture.photoRequests.length===2)
  await cancelled.evaluate(()=>fixture.photoRequests[1].resolve({vin:'NOTSELECTED',make:'Photo',model:'Preview'}))
  await cancelled.waitForFunction(()=>document.querySelector('input[placeholder="Rio"]').value==='Preview')
  await cancelled.getByRole('button',{name:'Скасувати',exact:true}).click()
  await save(cancelled).click();await waitSaved(cancelled)
  assert.equal(await cancelled.evaluate(()=>fixture.writes[0].body.vehicle_info.vin),'BEFOREPHOTO');await cancelled.close()
  const switched=await setup('vehicle');await photo(switched);await switched.waitForFunction(()=>fixture.photoRequests.length===1)
  await switched.getByRole('button',{name:'Змінити',exact:true}).first().click()
  await switched.getByRole('button',{name:/Другий клієнт/}).click()
  await switched.waitForFunction(()=>document.body.textContent.includes('New Current'))
  await switched.evaluate(()=>fixture.photoRequests[0].resolve({vin:'WRONGCLIENT',make:'Wrong',model:'Old photo'}))
  await save(switched).click();await waitSaved(switched)
  assert.equal(await switched.evaluate(()=>fixture.writes[0].body.customer_id),'b')
  assert.equal(await switched.evaluate(()=>fixture.writes[0].body.vehicle_info.vin),'NEWVIN');await switched.close()
  const savedDuringRead=await setup('vehicle');await photo(savedDuringRead)
  await savedDuringRead.waitForFunction(()=>fixture.photoRequests.length===1)
  await save(savedDuringRead).click();await waitSaved(savedDuringRead)
  await savedDuringRead.evaluate(()=>fixture.photoRequests[0].resolve({vin:'LATE',make:'Late',model:'Unloaded'}))
  await savedDuringRead.waitForTimeout(100)
  assert.equal(await savedDuringRead.evaluate(()=>fixture.writes[0].body.vehicle_info.vin),'WVWZZZ1JZXW000001')
  assert.equal(await savedDuringRead.evaluate(()=>fixture.messages.some(m=>m.includes('LATE'))),false);await savedDuringRead.close()
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: durable restart, double click/final quantity, lost reply, pending restart/check-only recovery, absent result retry, corrupt storage, late customer/garage response, stale version retained, manual price protected; vehicle OCR/decode manual corrections, out-of-order photos, stale errors, cancel, client switch, save/unmount, authoritative edited vehicle payload; no live services or DB.')
}finally{await browser?.close();await server.close()}
