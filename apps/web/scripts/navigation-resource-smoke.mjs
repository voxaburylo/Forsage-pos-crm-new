// Repeated real component mounts in an isolated browser. All services are synthetic.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {chromium} from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const mocks={
  '@/lib/auth':'export const signOut=async()=>{}',
  '@/stores/authStore':'const state={offlineMode:true,session:{user:{id:"test",app_metadata:{role:"owner",tenant_id:"fixture"}}}};export const useAuthStore=Object.assign(s=>s?s(state):state,{getState:()=>state})',
  '@/lib/api':'export const api={get:async()=>({data:[]})}',
  '@/features/orders/orderApi':'export const orderApi={list:async()=>{fixture.orderReads++;await fixture.delay(2);return {data:[],meta:{has_more:false}}}}',
  '@/features/suppliers/supplierApi':'export const supplierApi={list:async()=>({data:[]})}',
  '@/components/ui/Toast':'export const toast={error:m=>fixture.errors.push(m),warning:()=>{},success:()=>{}};export function ToastContainer(){return null}',
}
const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter,useNavigate}from'react-router-dom';import{Sidebar}from'/src/components/Sidebar.tsx';import OrdersPage from'/src/features/orders/OrdersPage.tsx';import'/src/index.css';function Probe(){const[screen,setScreen]=useState('empty');fixture.screen=setScreen;fixture.navigate=useNavigate();return <div data-screen={screen}>{screen==='sidebar'?<Sidebar/>:screen==='orders'?<OrdersPage/>:null}</div>}createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/orders']}><Probe/></MemoryRouter>);`
const bootstrap=`
window.fixture={errors:[],countReads:0,listReads:0,orderReads:0,live:0,peak:0,slow:false,waiters:[],hidden:false};
fixture.delay=ms=>new Promise(r=>setTimeout(r,ms));
window.forsageDesktop={orders:{count:async()=>{fixture.countReads++;fixture.live++;fixture.peak=Math.max(fixture.peak,fixture.live);try{if(fixture.slow)await new Promise(r=>fixture.waiters.push(r));else await fixture.delay(2);return 1234}finally{fixture.live--}},list:async()=>{fixture.listReads++;throw Error('Full order history should not be loaded by badge')},offlineStatus:async()=>({client:false,connected:true,pending:0,blocked:0})}};
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>fixture.hidden?'hidden':'visible'});
fixture.listeners=new Map();for(const[target,name]of[[window,'window'],[document,'document']]){const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);target.addEventListener=(type,fn,opts)=>{if(type.startsWith('forsage:')||['focus','visibilitychange','paste','keydown'].includes(type)){const key=name+':'+type;const group=fixture.listeners.get(key)??new Set();group.add(fn);fixture.listeners.set(key,group)}return add(type,fn,opts)};target.removeEventListener=(type,fn,opts)=>{fixture.listeners.get(name+':'+type)?.delete(fn);return remove(type,fn,opts)}}
fixture.listenerCount=()=>[...fixture.listeners.values()].reduce((sum,set)=>sum+set.size,0);
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'navigation-resource-fixture',enforce:'pre',resolveId(id){if(id==='virtual:resource.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:resource.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/resource-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/resource-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:resource.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1300,height:900}}),base=server.resolvedUrls.local[0],errors=[],blocked=[]
  page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)})
  await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():(blocked.push(r.request().url()),r.abort()))
  await page.goto(base+'resource-test');await page.waitForFunction(()=>typeof fixture.screen==='function')
  const baselineListeners=await page.evaluate(()=>fixture.listenerCount())
  const show=async screen=>{await page.evaluate(s=>fixture.screen(s),screen);await page.locator('[data-screen='+screen+']').waitFor({state:'attached'});if(screen!=='empty')await page.waitForFunction(()=>fixture.live===0);else await page.waitForFunction(n=>fixture.listenerCount()===n,baselineListeners)}
  await show('sidebar');await page.getByText('1234',{exact:true}).waitFor()
  const before=await page.evaluate(()=>fixture.countReads)
  for(let i=0;i<100;i++)await page.evaluate(i=>fixture.navigate('/products?page='+i),i)
  assert.equal(await page.evaluate(()=>fixture.countReads),before,'route changes must not reread badge')
  await page.evaluate(()=>{fixture.slow=true;window.dispatchEvent(new Event('focus'))})
  await page.waitForFunction(()=>fixture.live===1)
  await page.evaluate(()=>{for(let i=0;i<1000;i++)window.dispatchEvent(new Event('focus'))})
  assert.equal(await page.evaluate(()=>fixture.live),1)
  await page.evaluate(()=>{fixture.slow=false;fixture.waiters.shift()()})
  await page.waitForFunction(n=>fixture.countReads>=n+2&&fixture.live===0,before)
  assert.equal(await page.evaluate(()=>fixture.peak),1)
  await page.evaluate(()=>{fixture.hidden=true;document.dispatchEvent(new Event('visibilitychange'))})
  const hiddenReads=await page.evaluate(()=>fixture.countReads)
  for(let i=0;i<20;i++)await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  assert.equal(await page.evaluate(()=>fixture.countReads),hiddenReads)
  await page.evaluate(()=>{fixture.hidden=false;document.dispatchEvent(new Event('visibilitychange'))})
  await page.waitForFunction(n=>fixture.countReads===n+1&&fixture.live===0,hiddenReads)
  await show('empty');await page.evaluate(()=>fixture.navigate('/orders'))
  // Warm V8 and React before recording retained heap, DOM nodes, and event listeners.
  for(let i=0;i<12;i++){await show('orders');await show('empty')}
  const cdp=await page.context().newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage')
  const firstMemory=await cdp.send('Runtime.getHeapUsage'),firstDom=await cdp.send('Memory.getDOMCounters')
  const cycles=Number(process.env.FORSAGE_RESOURCE_CYCLES??200)
  assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=5000)
  const start=Date.now()
  for(let i=0;i<cycles;i++){await show(i%2?'orders':'sidebar');await show('empty')}
  await cdp.send('HeapProfiler.collectGarbage')
  const finalMemory=await cdp.send('Runtime.getHeapUsage'),finalDom=await cdp.send('Memory.getDOMCounters')
  assert.equal(await page.evaluate(()=>fixture.listenerCount()),baselineListeners)
  assert.equal(await page.evaluate(()=>fixture.listReads),0)
  assert(finalMemory.usedSize-firstMemory.usedSize<12*1024*1024,'retained heap grew by >12MB')
  assert(finalDom.nodes-firstDom.nodes<500,'detached DOM nodes accumulated')
  const reads=await page.evaluate(()=>[fixture.countReads,fixture.orderReads])
  await page.evaluate(()=>{for(let i=0;i<100;i++){window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('forsage:desktop-sync-completed'));document.dispatchEvent(new Event('visibilitychange'))}})
  assert.deepEqual(await page.evaluate(()=>[fixture.countReads,fixture.orderReads]),reads)
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(await page.evaluate(()=>fixture.errors),[])
  console.log(JSON.stringify({success:true,cycles,elapsedMs:Date.now()-start,routeChanges:100,burstEvents:1000,maxConcurrentBadgeReads:1,retainedHeapDelta:finalMemory.usedSize-firstMemory.usedSize,domNodeDelta:finalDom.nodes-firstDom.nodes,domListenerDelta:finalDom.jsEventListeners-firstDom.jsEventListeners,requestsAfterUnmount:0}))
}finally{await browser?.close();await server.close()}
