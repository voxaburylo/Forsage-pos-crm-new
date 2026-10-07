// Real catalog agent UI, synthetic catalog and API only. No shop data or external network.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {chromium} from 'playwright'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const require=createRequire(path.join(root,'apps/web/package.json'))
const {createServer,transformWithEsbuild}=await import(pathToFileURL(require.resolve('vite')).href)
const mocks={
 '@/stores/authStore':'export const useAuthStore=Object.assign(s=>s(fixture.state),{getState:()=>fixture.state})',
 '@/lib/desktopBridge':'export const desktopBridge=()=>({catalog:{agentScan:async()=>{fixture.scans++;await new Promise(r=>setTimeout(r,40));return fixture.scan},agentApply:async body=>{fixture.writes.push(body);await new Promise(r=>setTimeout(r,40));return {updated:body.items.length,backupPath:"test-only"}}}})',
 '@/features/ai/aiApi':'export const aiApi={reviewCatalog:async body=>{fixture.requests++;if(fixture.defer)await new Promise(r=>fixture.release=r);return {data:{proposals:fixture.proposals.filter(row=>body.products.some(product=>product.id===row.id))}}}}',
 '@/components/Layout':'export const Layout=({children})=><main>{children}</main>',
 '@/components/ui/Toast':'export const toast={success:m=>fixture.messages.push(m)}',
 '@/components/ui':'export const Button=({children,onClick,disabled})=><button disabled={disabled} onClick={onClick}>{children}</button>;export const Card=({children})=><section>{children}</section>;export const ConfirmDialog=({open,onConfirm})=>open?<button onClick={onConfirm}>Confirm fixture</button>:null',
}
const bootstrap=`window.fixture={state:{session:{user:{id:'owner',app_metadata:{tenant_id:'shop',role:'owner'}}}},scans:0,requests:0,writes:[],messages:[],proposals:[],scan:{products:[{id:'a',name:'Фильтр W67/1',sku:'A',brand:'',category_id:null,fingerprint:'fa'},{id:'b',name:'Олива 4 л',sku:'B',brand:'',category_id:null,fingerprint:'fb'}],categories:[],issues:[],total:2}};`
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import Page from '/src/features/ai/CatalogAgentPage.tsx';function App(){const [version,setVersion]=React.useState(0);fixture.refresh=()=>setVersion(v=>v+1);return <div data-version={version}><Page/></div>}createRoot(document.getElementById('root')).render(<MemoryRouter><App/></MemoryRouter>);`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{name:'agent-fixture',enforce:'pre',resolveId(id){if(id==='virtual:agent.tsx'||Object.hasOwn(mocks,id))return '\0'+id},async load(id){if(id==='\0virtual:agent.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').replace(/\/index$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},configureServer(s){s.middlewares.use('/test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await s.transformIndexHtml('/test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:agent.tsx"></script></body></html>'))})}}]})
let browser
try{
 await server.listen();browser=await chromium.launch({headless:true})
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Fixture page error:',e.message)})
 const base=server.resolvedUrls.local[0]
 await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort())
 await page.goto(base+'test')
 const scan=page.getByRole('button',{name:'Перевірити каталог',exact:true})
 const review=page.getByRole('button',{name:'AI: перевірити назви й категорії',exact:true})
 await scan.evaluate(b=>{b.click();b.click()})
 await page.getByText(/Перевірено AI: 0 \/ 2/).waitFor()
 assert.equal(await page.evaluate(()=>fixture.scans),1)
 await review.evaluate(b=>{b.click();b.click()})
 await page.getByRole('alert').filter({hasText:'неповну'}).waitFor()
 assert.equal(await page.evaluate(()=>fixture.requests),1)
 await page.getByText(/Перевірено AI: 0 \/ 2/).waitFor()
 await page.evaluate(()=>{fixture.proposals=fixture.scan.products.map(({id,name,sku,category_id})=>({id,name:id==='a'?'Фільтр W67/1':name,sku,category_id,reason:'Переклад'}))})
 await review.click()
 await page.getByText(/Перевірено AI: 2 \/ 2/).waitFor()
 await page.getByRole('checkbox',{name:'Підтвердити Фильтр W67/1'}).check()
 await page.getByRole('button',{name:'Переглянуто — застосувати (1)',exact:true}).click()
 await page.getByRole('button',{name:'Confirm fixture'}).evaluate(b=>{b.click();b.click()})
 await page.waitForFunction(()=>fixture.messages.length===1&&fixture.scans===2)
 assert.equal(await page.evaluate(()=>fixture.writes.length),1)
 // Same user, different shop: no inherited review state or pending proposals.
 await page.evaluate(()=>{fixture.state.session.user.app_metadata.tenant_id='other-shop';fixture.refresh()})
 await page.getByText('Натисніть «Перевірити каталог», щоб побачити зауваження.',{exact:true}).waitFor()
 await scan.click();await page.getByText(/Перевірено AI: 0 \/ 2/).waitFor()
 await page.evaluate(()=>{fixture.defer=true})
 await review.click();await page.waitForFunction(()=>typeof fixture.release==='function')
 await page.evaluate(()=>{fixture.state.session.user.id='other-owner';fixture.refresh()})
 await page.getByText('Натисніть «Перевірити каталог», щоб побачити зауваження.',{exact:true}).waitFor()
 await page.evaluate(()=>fixture.release())
 await page.waitForTimeout(100)
 assert.equal(await page.getByRole('checkbox').count(),0)
 // Read auth synchronously: React has not yet unmounted the previous view.
 for(const change of ['account','tenant','role']){
  await page.goto(base+'test');await scan.waitFor()
  await page.evaluate(()=>{
   fixture.scan.products=Array.from({length:26},(_,i)=>({id:'p'+i,name:'Фильтр '+i,sku:'SKU'+i,brand:'',category_id:null,fingerprint:'fp'+i}))
   fixture.scan.total=26
   fixture.proposals=fixture.scan.products.map(p=>({id:p.id,name:p.name.replace('Фильтр','Фільтр'),sku:p.sku,category_id:null,reason:'Переклад'}))
   fixture.defer=true
  })
  await scan.click();await page.getByText(/Перевірено AI: 0 \/ 26/).waitFor()
  await review.click();await page.waitForFunction(()=>typeof fixture.release==='function')
  await page.evaluate(change=>{
   if(change==='account')fixture.state.session.user.id='another'
   if(change==='tenant')fixture.state.session.user.app_metadata.tenant_id='another'
   if(change==='role')fixture.state.session.user.app_metadata.role='cashier'
   fixture.release()
  },change)
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>fixture.requests),1,change+' must not send the next batch')
  assert.equal(await page.getByRole('checkbox').count(),0,change+' must not display stale proposals')
  await page.goto(base+'test');await scan.waitFor()
  await page.evaluate(()=>{fixture.proposals=fixture.scan.products.map(p=>({id:p.id,name:p.name.replace('Фильтр','Фільтр'),sku:p.sku,category_id:null,reason:'Переклад'}))})
  await scan.click();await page.getByText(/Перевірено AI: 0 \/ 2/).waitFor()
  await review.click();await page.getByRole('checkbox',{name:'Підтвердити Фильтр W67/1'}).check()
  await page.getByRole('button',{name:'Переглянуто — застосувати (1)',exact:true}).click()
  await page.evaluate(change=>{
   if(change==='account')fixture.state.session.user.id='another'
   if(change==='tenant')fixture.state.session.user.app_metadata.tenant_id='another'
   if(change==='role')fixture.state.session.user.app_metadata.role='cashier'
  },change)
  await page.getByRole('button',{name:'Confirm fixture'}).click()
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>fixture.writes.length),0,change+' must block confirmation immediately')
 }
 assert.deepEqual(errors,[])
 console.log('PASS: catalog double-click guards, incomplete reply retry, full review, single write, tenant/account isolation, late reply and pre-render account/tenant/role revocation')
}finally{await browser?.close();await server.close()}
