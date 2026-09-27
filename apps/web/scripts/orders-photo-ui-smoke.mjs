// Real OrdersPage and shared photo preparation; no live accounts, OCR, database or clipboard.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { createSmokeCache } from './ui-smoke-cache.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const mocks={
 '@/features/orders/orderApi':'export const orderApi={list:async()=>({data:[],meta:{has_more:false}})}',
 '@/features/orders/OrderLanNotice':'export function OrderLanNotice(){return null};export function OrderLanBadge(){return null}',
 '@/features/customers/customerApi':'export const customerApi={}',
 '@/features/customers/customerVehiclesApi':'export const customerVehiclesApi={}',
 '@/features/suppliers/supplierApi':'export const supplierApi={list:async()=>({data:[]})}',
 '@/components/Sidebar':'export function Sidebar(){return null}',
 '@/components/SubNavTabs':'export function SubNavTabs(){return null};export const ORDERS_TABS=[]',
 '@/lib/api':'export const api={get:async()=>({data:[]})}',
 '@/lib/vehicleOcr':'export const recognizeVehicleImage=()=>new Promise((resolve,reject)=>fixture.requests.push({resolve,reject}))',
 '@/stores/authStore':"import{useSyncExternalStore}from'react';const state=()=>fixture.state;export const useAuthStore=Object.assign(select=>select(useSyncExternalStore(cb=>{fixture.listeners.add(cb);return()=>fixture.listeners.delete(cb)},state)),{getState:state})",
 '@/components/ui/Toast':'export const toast={success:m=>fixture.messages.push(m),error:m=>fixture.errors.push(m)};export function ToastContainer(){return null}',
}
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Routes,Route,useNavigate,useLocation}from'react-router-dom';import Orders from'/src/features/orders/OrdersPage.tsx';import{prepareImageDataUrl}from'/src/lib/prepareImage.ts';fixture.prepare=prepareImageDataUrl;function Controls(){const navigate=useNavigate(),location=useLocation();fixture.navigate=navigate;return <output data-testid="route">{location.pathname+location.search}</output>}createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/orders']}><Controls/><Routes><Route path='/orders' element={<Orders/>}/><Route path='*' element={<p>Other page</p>}/></Routes></MemoryRouter>);`
const bootstrap=`window.fixture={requests:[],messages:[],errors:[],listeners:new Set(),state:{offlineMode:true,session:{user:{id:'one',app_metadata:{tenant_id:'shop',role:'manager'}}}}};fixture.change=(field,value,notify=true)=>{fixture.state=structuredClone(fixture.state);if(field==='id')fixture.state.session.user.id=value;else fixture.state.session.user.app_metadata[field]=value;if(notify)fixture.listeners.forEach(cb=>cb())};fixture.vehicle={vin:'WVWZZZ1JZXW000001',make:'Volkswagen',model:'Golf',year:2001};`
const server=await createServer({configFile:false,cacheDir:createSmokeCache(),root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
 name:'orders-photo-fixture',enforce:'pre',
 resolveId(id){if(id==='virtual:orders-photo.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
 async load(id){
  if(id==='\0virtual:orders-photo.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})
  let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
  for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
  if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
 },
 configureServer(server){server.middlewares.use('/orders-photo-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/orders-photo-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:orders-photo.tsx"></script></body></html>'))})},
}]})
let browser
try {
 await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0],errors=[],blocked=[]
 const photo={name:'vin.png',mimeType:'image/png',buffer:Buffer.from('fixture-only')}
 async function setup(){
  const page=await browser.newPage()
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()))
  await page.goto(base+'orders-photo-test');await page.locator('input[type=file]').waitFor({state:'attached'});return page
 }
 const upload=page=>page.locator('input[type=file]').setInputFiles(photo)
 const button=page=>page.getByRole('button',{name:'Створити замовлення з фото VIN або техпаспорта'})
 const route=page=>page.getByTestId('route').textContent()
 const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const normal=await setup();await upload(normal);await upload(normal)
 assert.equal(await normal.evaluate(()=>fixture.requests.length),1)
 await normal.evaluate(()=>fixture.requests[0].resolve(fixture.vehicle))
 await normal.waitForFunction(()=>document.querySelector('[data-testid=route]').textContent.startsWith('/orders/new?vin='))
 assert.equal(await normal.evaluate(()=>fixture.messages.length),1);await normal.close()
 for(const outcome of ['resolve','reject']){
  const page=await setup();await upload(page)
  await page.evaluate(()=>fixture.navigate('/products'));await page.getByText('Other page').waitFor()
  await page.evaluate(outcome=>outcome==='resolve'?fixture.requests[0].resolve(fixture.vehicle):fixture.requests[0].reject(Error('old failure')),outcome)
  await settle(page);assert.equal(await route(page),'/products')
  assert.deepEqual(await page.evaluate(()=>[fixture.messages,fixture.errors]),[[],[]]);await page.close()
 }
 const returned=await setup();await upload(returned)
 await returned.evaluate(()=>fixture.navigate('/products'));await returned.getByText('Other page').waitFor()
 await returned.evaluate(()=>fixture.navigate('/orders'));await returned.locator('input[type=file]').waitFor({state:'attached'});await upload(returned)
 await returned.evaluate(()=>fixture.requests[0].resolve(fixture.vehicle));await settle(returned)
 assert.equal(await route(returned),'/orders');assert.equal(await button(returned).isDisabled(),true)
 await returned.evaluate(()=>fixture.requests[1].resolve(fixture.vehicle))
 await returned.waitForFunction(()=>document.querySelector('[data-testid=route]').textContent.startsWith('/orders/new?'))
 assert.equal(await returned.evaluate(()=>fixture.messages.length),1);await returned.close()
 for(const[field,value]of [['id','two'],['tenant_id','other'],['role','cashier']]){
  const page=await setup();await upload(page)
  await page.evaluate(([field,value])=>fixture.change(field,value),[field,value]);await settle(page)
  assert.equal(await button(page).isDisabled(),false)
  await page.evaluate(()=>fixture.requests[0].resolve(fixture.vehicle));await settle(page)
  assert.equal(await route(page),'/orders');assert.equal(await page.evaluate(()=>fixture.messages.length),0)
  await upload(page);await page.evaluate(()=>fixture.requests[1].resolve(fixture.vehicle))
  await page.waitForFunction(()=>document.querySelector('[data-testid=route]').textContent.startsWith('/orders/new?'));await page.close()
 }
 const immediate=await setup();await upload(immediate)
 await immediate.evaluate(()=>{fixture.change('id','two',false);fixture.requests[0].resolve(fixture.vehicle)})
 await settle(immediate);assert.equal(await route(immediate),'/orders');await immediate.close()
 const failed=await setup();await upload(failed)
 await failed.evaluate(()=>fixture.requests[0].reject(Error('visible failure')))
 await failed.waitForFunction(()=>fixture.errors.length===1)
 assert.equal(await button(failed).isDisabled(),false);await upload(failed)
 assert.equal(await failed.evaluate(()=>fixture.requests.length),2)
 const pixels=await failed.evaluate(async()=>{
  const source=document.createElement('canvas');source.width=16;source.height=16
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'))
  const values=[]
  for(const options of [{},{maxDimension:1600,quality:0.82}]){
   const url=await fixture.prepare(blob,options);const image=new Image()
   await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url})
   const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16
   const context=canvas.getContext('2d');context.drawImage(image,0,0)
   values.push(Array.from(context.getImageData(0,0,1,1).data))
  }
  return values
 })
 assert.deepEqual(pixels,[[255,255,255,255],[255,255,255,255]])
 await failed.close()
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 console.log('PASS: real OrdersPage photo success/retry/double click; late response after leave/return/account/tenant/role change ignored; transparent invoice and VIN JPEG are white. No live OCR or writes.')
} finally {await browser?.close();await server.close()}
