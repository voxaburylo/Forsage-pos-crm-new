// Isolated real router/hooks smoke; no application APIs, records, devices, or external traffic.
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
import{NavigationGuard,useUnsavedChanges}from'/src/hooks/useUnsavedChanges.ts';
import{useViewNavigation}from'/src/hooks/useViewNavigation.ts';
import{useViewScroll}from'/src/hooks/useViewScroll.ts';
function Draft({name}){const[value,setValue]=useState(''),[busy,setBusy]=useState(false);const{allowLeave}=useUnsavedChanges(!!value,busy);const{open}=useViewNavigation('/list');
 return <section><input aria-label={name} value={value} onChange={e=>setValue(e.target.value)}/><button onClick={()=>setBusy(v=>!v)}>Busy {name}</button><button onClick={allowLeave}>Allow {name}</button><button onClick={()=>{allowLeave();open('/done')}}>Save {name}</button><output data-testid={'busy-'+name}>{String(busy)}</output></section>}
function Editor(){return <><Draft name='first'/><Draft name='second'/></>}
function Page(){const{open,back}=useViewNavigation('/list');const scroll=useViewScroll(),location=useLocation();return <><button onClick={()=>open('/edit')}>Edit</button><button onClick={()=>open('/list?q=other')}>Other list</button><button onClick={back}>Back</button><main ref={scroll} data-testid='scroll' style={{height:200,overflow:'auto'}}><div style={{height:2500}}>Rows {location.search}</div></main></>}
function Shell(){const location=useLocation(),navigate=useNavigate();fixture.go=navigate;useEffect(()=>{fixture.guardReady=true;return()=>{fixture.guardReady=false}},[]);return <><NavigationGuard/><output data-testid='route'>{location.pathname+location.search}</output><button onClick={()=>navigate('/done')}>Leave</button><Routes><Route path='/edit' element={<Editor/>}/><Route path='/list' element={<Page/>}/><Route path='*' element={<p>Done</p>}/></Routes></>}
const router=(fixture.mode==='hash'?createHashRouter:createBrowserRouter)([{path:'*',element:<Shell/>}]);fixture.router=router;
createRoot(document.getElementById('root')).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
`
const server = await createServer({
  cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',
  optimizeDeps:{entries:[]},esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},
  server:{host:'127.0.0.1',port:0},plugins:[{
    name:'navigation-guard-fixture',enforce:'pre',
    resolveId(id){if(id==='virtual:guard.tsx'||id==='@/stores/authStore')return'\0'+id},
    async load(id){
      if(id==='\0virtual:guard.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});
      if(id==='\0@/stores/authStore'||id.replaceAll('\\','/').endsWith('/src/stores/authStore.ts'))return 'export const useAuthStore=select=>select({session:{user:{id:"synthetic",app_metadata:{role:"owner"}}}})';
    },
    configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
      if(!req.headers.accept?.includes('text/html'))return next();
      res.setHeader('content-type','text/html; charset=utf-8');
      res.end(await vite.transformIndexHtml(req.url,'<html><body><div id="root"></div><script>window.fixture={mode:window.testMode,confirmResult:false,confirms:0,alerts:0};window.confirm=()=>{fixture.confirms++;return fixture.confirmResult};window.alert=()=>fixture.alerts++;</script><script type="module" src="/@id/__x00__virtual:guard.tsx"></script></body></html>'));
    })},
  }],
})
let browser
const errors=[],blocked=[],results=[]
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0]
  const route=(page,value)=>page.waitForFunction(value=>document.querySelector('[data-testid=route]')?.textContent===value,value)
  async function setup(mode,start){const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',request=>new URL(request.request().url()).origin===new URL(base).origin?request.continue():(blocked.push(request.request().url()),request.abort()));await page.addInitScript(mode=>{window.testMode=mode},mode);await page.goto(mode==='hash'?base+'fixture#'+start:base+start.slice(1));await route(page,start);await page.waitForFunction(()=>fixture.guardReady===true);return page}
  // Main-process preflight is represented only by its public DOM event. No
  // Electron APIs, lifecycle IPC, app close, or real browser unload are invoked.
  const requestNativeUnload=(page,approved,{deadlineOffsetMs=30000,confirmDelayMs=0}={})=>page.evaluate(({approved,deadlineOffsetMs,confirmDelayMs})=>{
    fixture.confirmResult=approved
    const originalNow=Date.now,originalConfirm=window.confirm
    let now=originalNow()
    const detail={handled:false,approved:false,deadline:now+deadlineOffsetMs}
    // Only this synthetic prompt advances wall-clock time. The hook remains
    // real, and both globals are restored before any later browser interaction.
    if(confirmDelayMs){Date.now=()=>now;window.confirm=()=>{const result=originalConfirm();now+=confirmDelayMs;return result}}
    try{window.dispatchEvent(new CustomEvent('forsage:request-unload',{detail}))}
    finally{Date.now=originalNow;window.confirm=originalConfirm}
    return {handled:detail.handled,approved:detail.approved}
  },{approved,deadlineOffsetMs,confirmDelayMs})
  const preventsUnload=page=>page.evaluate(()=>{
    const event=new Event('beforeunload',{cancelable:true})
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  const dialogs=page=>page.evaluate(()=>({confirms:fixture.confirms,alerts:fixture.alerts}))
  for(const mode of ['browser','hash']){
    const page=await setup(mode,'/list');await page.getByRole('button',{name:'Edit',exact:true}).click();await route(page,'/edit');
    await page.getByLabel('second').fill('unsaved second form');await page.getByRole('button',{name:'Leave',exact:true}).click();
    await page.waitForFunction(()=>fixture.confirms===1);await route(page,'/edit');assert.equal(await page.getByLabel('second').inputValue(),'unsaved second form');
    assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}),true);
    await page.evaluate(()=>fixture.router.navigate(-1));await page.waitForFunction(()=>fixture.confirms===2);await route(page,'/edit');
    await page.evaluate(()=>{fixture.confirmResult=true;fixture.router.navigate(-1)});await route(page,'/list');
    await page.getByRole('button',{name:'Edit',exact:true}).click();await route(page,'/edit');await page.getByRole('button',{name:'Leave',exact:true}).click();await route(page,'/done');
    assert.equal(await page.evaluate(()=>fixture.confirms),3);results.push(mode+': aggregate dirty, cancelled/accepted POP, unload, clean remount');await page.close();

    const busy=await setup(mode,'/edit');await busy.getByRole('button',{name:'Busy first',exact:true}).click();await busy.getByRole('button',{name:'Leave',exact:true}).click();await busy.waitForFunction(()=>fixture.alerts===1);await route(busy,'/edit');assert.equal(await busy.evaluate(()=>fixture.confirms),0);
    await busy.getByRole('button',{name:'Busy first',exact:true}).click();await busy.getByLabel('first').fill('saved');await busy.getByRole('button',{name:'Save first',exact:true}).click();await route(busy,'/done');assert.equal(await busy.evaluate(()=>fixture.confirms),0);results.push(mode+': busy denies departure, successful save allows departure');await busy.close();

    const aggregate=await setup(mode,'/edit');await aggregate.getByLabel('first').fill('saved');await aggregate.getByLabel('second').fill('still unsaved');await aggregate.getByRole('button',{name:'Save first',exact:true}).click();await aggregate.waitForFunction(()=>fixture.confirms===1);await route(aggregate,'/edit');assert.equal(await aggregate.getByLabel('second').inputValue(),'still unsaved');results.push(mode+': save permission never bypasses another dirty form');await aggregate.close();

    const nativeCancel=await setup(mode,'/edit');await nativeCancel.getByLabel('first').fill('native unsaved');
    assert.deepEqual(await requestNativeUnload(nativeCancel,false),{handled:true,approved:false});
    assert.deepEqual(await dialogs(nativeCancel),{confirms:1,alerts:0},'confirmation occurs in request-unload, before beforeunload');
    assert.equal(await preventsUnload(nativeCancel),true);
    assert.deepEqual(await dialogs(nativeCancel),{confirms:1,alerts:0},'beforeunload itself never displays a custom confirmation');
    assert.deepEqual(await requestNativeUnload(nativeCancel,true),{handled:true,approved:true});
    assert.deepEqual(await requestNativeUnload(nativeCancel,false),{handled:true,approved:false},'a later cancellation revokes an unused permit');
    assert.equal(await preventsUnload(nativeCancel),true);assert.equal(await nativeCancel.getByLabel('first').inputValue(),'native unsaved');
    results.push(mode+': native dirty cancel retains draft and revokes earlier approval');await nativeCancel.close();

    const nativeAccept=await setup(mode,'/edit');await nativeAccept.getByLabel('first').fill('native approved');
    assert.deepEqual(await requestNativeUnload(nativeAccept,true),{handled:true,approved:true});
    assert.equal(await preventsUnload(nativeAccept),false,'exactly the first unchanged-state beforeunload consumes approval');
    assert.equal(await preventsUnload(nativeAccept),true,'approval must not survive an already attempted unload');
    assert.deepEqual(await dialogs(nativeAccept),{confirms:1,alerts:0});await route(nativeAccept,'/edit');
    results.push(mode+': native approval permits exactly one beforeunload');await nativeAccept.close();

    const nativeBusy=await setup(mode,'/edit');await nativeBusy.getByRole('button',{name:'Busy first',exact:true}).click();
    assert.deepEqual(await requestNativeUnload(nativeBusy,true),{handled:true,approved:false});
    assert.deepEqual(await dialogs(nativeBusy),{confirms:0,alerts:1},'busy is denied without asking to discard an in-flight write');
    assert.equal(await preventsUnload(nativeBusy),true);assert.deepEqual(await dialogs(nativeBusy),{confirms:0,alerts:1});
    results.push(mode+': native busy denies with alert, without confirmation');await nativeBusy.close();

    const nativeRevision=await setup(mode,'/edit');await nativeRevision.getByLabel('first').fill('approved revision');
    assert.deepEqual(await requestNativeUnload(nativeRevision,true),{handled:true,approved:true});
    await nativeRevision.getByRole('button',{name:'Busy first',exact:true}).click();
    assert.equal(await preventsUnload(nativeRevision),true,'a newly busy draft invalidates earlier approval');
    await nativeRevision.getByRole('button',{name:'Busy first',exact:true}).click();
    assert.deepEqual(await requestNativeUnload(nativeRevision,true),{handled:true,approved:true});
    await nativeRevision.getByLabel('second').fill('new dirty revision');
    assert.equal(await preventsUnload(nativeRevision),true,'another newly dirty form invalidates earlier approval');
    assert.deepEqual(await requestNativeUnload(nativeRevision,true),{handled:true,approved:true});
    await nativeRevision.getByLabel('first').fill('');await nativeRevision.getByLabel('first').fill('new first draft');
    assert.equal(await preventsUnload(nativeRevision),true,'clean-to-dirty changes cannot inherit an old permit');
    assert.deepEqual(await dialogs(nativeRevision),{confirms:3,alerts:0});
    results.push(mode+': dirty and busy revisions invalidate native approval');await nativeRevision.close();

    const nativeClean=await setup(mode,'/edit');
    assert.deepEqual(await requestNativeUnload(nativeClean,false),{handled:true,approved:true},'clean departure requires no confirmation');
    assert.equal(await preventsUnload(nativeClean),false);assert.equal(await preventsUnload(nativeClean),false);
    assert.deepEqual(await dialogs(nativeClean),{confirms:0,alerts:0});
    results.push(mode+': native clean departure allowed without dialogs');await nativeClean.close();

    const expiredRequest=await setup(mode,'/edit');await expiredRequest.getByLabel('first').fill('expired request draft');
    assert.deepEqual(await requestNativeUnload(expiredRequest,true,{deadlineOffsetMs:-1}),{handled:true,approved:false});
    assert.deepEqual(await dialogs(expiredRequest),{confirms:0,alerts:0},'an already expired request cannot open a prompt');
    assert.equal(await preventsUnload(expiredRequest),true);results.push(mode+': expired native request denied without prompt');await expiredRequest.close();

    const expiredPrompt=await setup(mode,'/edit');await expiredPrompt.getByLabel('first').fill('draft after slow prompt');
    assert.deepEqual(await requestNativeUnload(expiredPrompt,true,{deadlineOffsetMs:100,confirmDelayMs:101}),{handled:true,approved:false});
    assert.deepEqual(await dialogs(expiredPrompt),{confirms:1,alerts:0},'confirmation finished after the original deadline');
    assert.equal(await preventsUnload(expiredPrompt),true,'a late positive answer must not leave any unload permission');
    results.push(mode+': late confirmation denied after original deadline');await expiredPrompt.close();

    const expiredPermit=await setup(mode,'/edit');await expiredPermit.getByLabel('first').fill('unused permit draft');
    assert.deepEqual(await requestNativeUnload(expiredPermit,true),{handled:true,approved:true});
    await expiredPermit.waitForTimeout(1100)
    assert.equal(await preventsUnload(expiredPermit),true,'unused approval expires after one second even before the request deadline');
    assert.deepEqual(await dialogs(expiredPermit),{confirms:1,alerts:0});
    results.push(mode+': unused native permit expires after one second');await expiredPermit.close();

    const editedPermit=await setup(mode,'/edit');await editedPermit.getByLabel('first').fill('already dirty');
    assert.deepEqual(await requestNativeUnload(editedPermit,true),{handled:true,approved:true});
    await editedPermit.getByLabel('first').fill('still dirty but different input');
    assert.equal(await preventsUnload(editedPermit),true,'input revokes approval even when the dirty boolean never changed');
    assert.deepEqual(await requestNativeUnload(editedPermit,true),{handled:true,approved:true});
    await editedPermit.getByLabel('first').evaluate(input=>input.dispatchEvent(new Event('change',{bubbles:true})))
    assert.equal(await preventsUnload(editedPermit),true,'a subsequent change event independently revokes approval');
    assert.deepEqual(await dialogs(editedPermit),{confirms:2,alerts:0});
    results.push(mode+': input and change revoke permits for already-dirty drafts');await editedPermit.close();

    const nativeAggregate=await setup(mode,'/edit');await nativeAggregate.getByLabel('first').fill('saved first');await nativeAggregate.getByLabel('second').fill('pending second');
    await nativeAggregate.getByRole('button',{name:'Allow first',exact:true}).click();
    assert.deepEqual(await requestNativeUnload(nativeAggregate,false),{handled:true,approved:false});
    assert.equal(await preventsUnload(nativeAggregate),true);assert.deepEqual(await dialogs(nativeAggregate),{confirms:1,alerts:0});
    await nativeAggregate.getByLabel('second').fill('');
    assert.deepEqual(await requestNativeUnload(nativeAggregate,false),{handled:true,approved:true});
    assert.equal(await preventsUnload(nativeAggregate),false);assert.deepEqual(await dialogs(nativeAggregate),{confirms:1,alerts:0});
    results.push(mode+': native per-form save permission does not bypass another draft');await nativeAggregate.close();

    if(process.argv.includes('--scroll-proof')){
      const scroll=await setup(mode,'/list');await scroll.getByTestId('scroll').evaluate(node=>{node.scrollTop=800;node.dispatchEvent(new Event('scroll'))});
      await scroll.getByRole('button',{name:'Edit',exact:true}).click();await route(scroll,'/edit');await scroll.evaluate(()=>fixture.router.navigate(-1));await route(scroll,'/list');await scroll.waitForFunction(()=>document.querySelector('[data-testid=scroll]').scrollTop===800);
      await scroll.getByRole('button',{name:'Other list',exact:true}).click();await route(scroll,'/list?q=other');
      assert.equal(await scroll.getByTestId('scroll').evaluate(node=>node.scrollTop),0,'A new list query with no saved scroll starts at the top');results.push(mode+': saved scroll restored and new query starts at top');await scroll.close();
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log(JSON.stringify({ok:true,cases:results.length,results,externalRequests:blocked.length},null,2))
}finally{await browser?.close();await server.close()}
