// Actual Sidebar + ProtectedRoute + shared guard in an isolated router.
// Auth and APIs are synthetic; no application data, devices, or external traffic.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const entry = `
import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import{createBrowserRouter,createHashRouter,RouterProvider,Routes,Route,useLocation,useNavigate}from'react-router-dom';
import{Sidebar}from'/src/components/Sidebar.tsx';
import ProtectedRoute from'/src/components/ProtectedRoute.tsx';
import{NavigationGuard,useUnsavedChanges}from'/src/hooks/useUnsavedChanges.ts';
import{useAuthStore}from'@/stores/authStore';
function Draft({name}){
  const[value,setValue]=useState(''),[busy,setBusy]=useState(false);
  useUnsavedChanges(!!value,busy);
  useEffect(()=>()=>fixture.events.push('unmount:'+name),[]);
  return <section><input aria-label={name} value={value} onChange={e=>setValue(e.target.value)}/>
    <button onClick={()=>setBusy(v=>!v)}>Busy {name}</button>
    <output data-testid={'busy-'+name}>{String(busy)}</output></section>
}
function Editor(){return <><Sidebar isOpen/><Draft name='first'/><Draft name='second'/></>}
function Shell(){const location=useLocation(),navigate=useNavigate();fixture.go=navigate;
  fixture.session=()=>useAuthStore.getState().session;
  return <><NavigationGuard/><output data-testid='route'>{location.pathname}</output><Routes>
    <Route path='/edit' element={<ProtectedRoute><Editor/></ProtectedRoute>}/>
    <Route path='/login' element={<p>Login fixture</p>}/>
    <Route path='*' element={<p>Destination fixture</p>}/>
  </Routes></>
}
const router=(fixture.mode==='hash'?createHashRouter:createBrowserRouter)([{path:'*',element:<Shell/>}]);
createRoot(document.getElementById('root')).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
`
const modules = {
  '@/stores/authStore': `import{create}from'zustand';
    export const useAuthStore=create(set=>({loading:false,session:{user:{id:'synthetic-cashier',app_metadata:{role:'cashier',tenant_id:'synthetic-shop'}}},setSession:session=>set({session})}));`,
  '@/lib/auth': `import{useAuthStore}from'@/stores/authStore';
    export async function signOut(){
      fixture.authCalls++;fixture.events.push('auth');
      if(fixture.authMode==='reject')throw Error('Synthetic logout failure');
      if(fixture.authMode==='defer')await new Promise((resolve,reject)=>{fixture.resolveAuth=resolve;fixture.rejectAuth=reject});
      fixture.revocations++;fixture.events.push('revoke');useAuthStore.getState().setSession(null);
    }`,
  '@/lib/api': `export const api={get(){fixture.apiCalls++;throw Error('Unexpected application API access')}};`,
  '@/lib/desktopBridge': `export const isDesktopRuntime=()=>fixture.mode==='hash';export const desktopBridge=()=>null;`,
  '@/features/inventory/pickingApi': `export const PICKING_STATUSES=[];`,
  '@/components/ui/Toast': `export const toast={error:message=>{fixture.toasts.push(message)}};`,
}
const server = await createServer({
  cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',
  optimizeDeps:{entries:[]},esbuild:{jsx:'automatic'},
  resolve:{alias:{'@':path.join(root,'apps/web/src')}},
  server:{host:'127.0.0.1',port:0},plugins:[{
    name:'sidebar-logout-fixture',enforce:'pre',
    resolveId(id){if(id==='virtual:sidebar-logout.tsx'||id in modules)return '\0'+id},
    async load(id){
      if(id==='\0virtual:sidebar-logout.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});
      const normalized=id.replaceAll('\\','/');
      for(const [key,source] of Object.entries(modules)){
        if(id==='\0'+key||normalized.endsWith('/src/'+key.slice(2)+'.ts')||normalized.endsWith('/src/'+key.slice(2)+'.tsx'))return source;
      }
    },
    configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
      if(!req.headers.accept?.includes('text/html'))return next();
      res.setHeader('content-type','text/html; charset=utf-8');
      res.end(await vite.transformIndexHtml(req.url,`<html><body><div id="root"></div><script>
        window.fixture={mode:window.testMode,confirmResult:false,confirms:0,alerts:0,authCalls:0,revocations:0,apiCalls:0,authMode:'success',events:[],toasts:[]};
        window.confirm=()=>{fixture.confirms++;fixture.events.push('confirm');return fixture.confirmResult};
        window.alert=()=>{fixture.alerts++;fixture.events.push('alert')};
      </script><script type="module" src="/@id/__x00__virtual:sidebar-logout.tsx"></script></body></html>`));
    })},
  }],
})

let browser
const errors=[],blocked=[],results=[]
try {
  await server.listen();browser=await chromium.launch({headless:true})
  const base=server.resolvedUrls.local[0]
  const route=(page,value)=>page.waitForFunction(value=>document.querySelector('[data-testid=route]')?.textContent===value,value)
  async function setup(mode){
    const page=await browser.newPage();page.setDefaultTimeout(6000)
    page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/*',request=>new URL(request.request().url()).origin===new URL(base).origin
      ?request.continue():(blocked.push(request.request().url()),request.abort()))
    await page.addInitScript(mode=>{window.testMode=mode},mode)
    await page.goto(mode==='hash'?base+'fixture#/edit':base+'edit')
    await route(page,'/edit');await page.getByLabel('first',{exact:true}).waitFor()
    await page.evaluate(()=>{fixture.events=[]})
    return page
  }
  const state=page=>page.evaluate(()=>({authCalls:fixture.authCalls,revocations:fixture.revocations,
    confirms:fixture.confirms,alerts:fixture.alerts,session:!!fixture.session(),events:[...fixture.events],toasts:[...fixture.toasts]}))
  const logout=page=>page.getByRole('button',{name:'Вийти',exact:true}).click()
  async function run(mode,name,body){
    const page=await setup(mode)
    try{await body(page);assert.equal(await page.evaluate(()=>fixture.apiCalls),0);results.push({mode,name,ok:true})}
    catch(error){results.push({mode,name,ok:false,error:String(error?.message??error)})}
    finally{await page.close()}
  }
  for(const mode of ['browser','hash']){
    await run(mode,'dirty cancel never calls auth or unmounts the form',async page=>{
      await page.getByLabel('second',{exact:true}).fill('unsaved customer data');await logout(page)
      await page.waitForFunction(()=>fixture.confirms>0||fixture.authCalls>0)
      assert.equal((await state(page)).authCalls,0,'Cancel must precede every auth/revocation call')
      await route(page,'/edit');assert.equal(await page.getByLabel('second',{exact:true}).inputValue(),'unsaved customer data')
      assert.deepEqual(await state(page),{authCalls:0,revocations:0,confirms:1,alerts:0,session:true,events:['confirm'],toasts:[]})
    })
    await run(mode,'busy clean form denies logout without confirmation',async page=>{
      await page.getByRole('button',{name:'Busy first',exact:true}).click();await logout(page)
      await page.waitForFunction(()=>fixture.alerts>0||fixture.authCalls>0)
      assert.equal((await state(page)).authCalls,0,'Busy operation must deny auth/logout')
      await route(page,'/edit');assert.deepEqual(await state(page),{authCalls:0,revocations:0,confirms:0,alerts:1,session:true,events:['alert'],toasts:[]})
    })
    await run(mode,'busy second form overrides accepted dirty departure',async page=>{
      await page.getByLabel('first',{exact:true}).fill('dirty first')
      await page.getByRole('button',{name:'Busy second',exact:true}).click();await page.evaluate(()=>{fixture.confirmResult=true});await logout(page)
      await page.waitForFunction(()=>fixture.alerts>0||fixture.authCalls>0)
      const value=await state(page);assert.equal(value.authCalls,0);assert.equal(value.confirms,0);assert.equal(value.alerts,1)
      assert.equal(value.session,true);assert.equal(await page.getByLabel('first',{exact:true}).inputValue(),'dirty first')
    })
    await run(mode,'accepted dirty logout confirms before exactly one auth call',async page=>{
      await page.getByLabel('first',{exact:true}).fill('discard explicitly');await page.evaluate(()=>{fixture.confirmResult=true});await logout(page)
      await route(page,'/login');const value=await state(page)
      assert.equal(value.authCalls,1);assert.equal(value.revocations,1);assert.equal(value.confirms,1);assert.equal(value.session,false)
      assert.deepEqual(value.events.slice(0,3),['confirm','auth','revoke'])
    })
    await run(mode,'clean logout needs no confirmation',async page=>{
      await logout(page);await route(page,'/login');const value=await state(page)
      assert.equal(value.authCalls,1);assert.equal(value.revocations,1);assert.equal(value.confirms,0);assert.equal(value.session,false)
    })
    await run(mode,'failed logout preserves draft, session, guard and retry',async page=>{
      await page.getByLabel('first',{exact:true}).fill('keep after failure')
      await page.evaluate(()=>{fixture.confirmResult=true;fixture.authMode='reject'});await logout(page)
      await page.waitForFunction(()=>fixture.toasts.length===1)
      const failed=await state(page);assert.equal(failed.authCalls,1);assert.equal(failed.revocations,0);assert.equal(failed.confirms,1);assert.equal(failed.session,true)
      assert.equal(await page.getByLabel('first',{exact:true}).inputValue(),'keep after failure')
      assert.equal(await page.getByRole('button',{name:'Вийти',exact:true}).isEnabled(),true)
      await page.evaluate(()=>{fixture.confirmResult=false;fixture.go('/products')})
      await page.waitForFunction(()=>fixture.confirms===2);await route(page,'/edit')
      await logout(page);assert.equal((await state(page)).confirms,3);assert.equal((await state(page)).authCalls,1)
      await page.evaluate(()=>{fixture.confirmResult=true;fixture.authMode='success'});await logout(page);await route(page,'/login')
      const retried=await state(page);assert.equal(retried.authCalls,2);assert.equal(retried.revocations,1);assert.equal(retried.confirms,4)
    })
    await run(mode,'same-tick double click and held reply stay single flight',async page=>{
      await page.getByLabel('first',{exact:true}).fill('explicitly discarded once')
      await page.evaluate(()=>{fixture.confirmResult=true;fixture.authMode='defer';const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Вийти');button.click();button.click()})
      await page.waitForFunction(()=>fixture.authCalls===1&&typeof fixture.resolveAuth==='function')
      const pending=await state(page);assert.equal(pending.confirms,1);assert.equal(pending.revocations,0);assert.equal(pending.session,true)
      assert.equal(await page.getByRole('button',{name:'Вийти',exact:true}).isDisabled(),true)
      await page.getByRole('button',{name:'Вийти',exact:true}).evaluate(button=>button.click())
      assert.equal((await state(page)).authCalls,1)
      await page.evaluate(()=>fixture.resolveAuth());await route(page,'/login')
      const completed=await state(page);assert.equal(completed.authCalls,1);assert.equal(completed.revocations,1);assert.equal(completed.confirms,1)
    })
  }
  const ok=results.every(result=>result.ok)&&errors.length===0&&blocked.length===0
  console.log(JSON.stringify({ok,cases:results.length,results,pageErrors:errors,externalRequests:blocked},null,2))
  assert.equal(ok,true,'Sidebar logout contracts must pass for browser and desktop hash routers')
} finally { await browser?.close();await server.close() }
