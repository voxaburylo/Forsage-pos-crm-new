// Keyboard ownership in actual dialogs; all financial APIs are in-memory fixtures.
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
  '@/features/pos/cashOperationApi': 'export const cashOperationApi={create:fixture.write}',
  '@/features/pos/saleApi': 'export const saleApi={suspend:fixture.write}',
  '@/components/ui/Toast': 'export const toast={error:()=>{},success:()=>{}};export function ToastContainer(){return null}',
}
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Modal}from'/src/components/ui/Modal.tsx';import{useDialogEscape}from'/src/hooks/useDialogEscape.ts';import{CashOperationModal}from'/src/features/pos/CashOperationModal.tsx';import{SuspendModal}from'/src/features/pos/SuspendModal.tsx';import{usePOSStore}from'/src/stores/posStore.ts';import'/src/index.css';
const s=usePOSStore.getState();s.replaceOpenReceipts([]);s.setCurrentShift({id:'fixture-shift'});s.addItem({productId:'fixture-part',sku:'fixture',name:'Fixture',unit:'шт',qty:1,unitPrice:10000,discount:0,qtyOnHand:1});fixture.store=usePOSStore;
function Custom({open,onClose}){const[busy,setBusy]=useState(false);fixture.busy=setBusy;useDialogEscape(open,onClose,{disabled:busy});if(!open)return null;return <section role="dialog" aria-modal="true" aria-label="Внутрішній"><input aria-label="Поле списку" onKeyDown={e=>{if(e.key==='Escape'&&fixture.childHandles){fixture.childEvents++;e.stopPropagation()}}}/><button disabled={busy}>Остання кнопка</button></section>}
function App(){const[outer,setOuter]=useState(true);const[inner,setInner]=useState(false);const dismiss=()=>{fixture.closed.push('outer');setOuter(false)};return fixture.screen==='cash'?<CashOperationModal open={outer} shiftId="fixture-shift" onClose={dismiss}/>:fixture.screen==='suspend'?<SuspendModal open={outer} onClose={dismiss} onSuspended={dismiss}/>:<><Modal open={outer} title="Зовнішній" onClose={dismiss}><button onClick={()=>setInner(true)}>Відкрити внутрішній</button></Modal><Custom open={inner} onClose={()=>{fixture.closed.push('inner');setInner(false)}}/></>}
createRoot(document.getElementById('root')).render(<App/>);`
const bootstrap = `window.fixture={screen:window.testScreen??'nested',closed:[],writes:[],childEvents:0,childHandles:false};fixture.write=async(...args)=>{fixture.writes.push(args);await new Promise(resolve=>fixture.release=resolve);return{data:{id:'fixture-result'}}};`
const server = await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'dialog-escape-smoke',enforce:'pre',resolveId(id){if(id==='virtual:dialog-escape.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:dialog-escape.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const[name,mock]of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(instance){instance.middlewares.use('/dialog-escape-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await instance.transformIndexHtml('/dialog-escape-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:dialog-escape.tsx"></script></body></html>'))})},
}]})
let browser
const errors=[],blocked=[],passed=[]
try{
  await server.listen();browser=await chromium.launch({headless:true});const base=server.resolvedUrls.local[0]
  async function setup(screen='nested'){const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(8000);page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)});await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():(blocked.push(route.request().url()),route.abort()));await page.addInitScript(screen=>window.testScreen=screen,screen);await page.goto(base+'dialog-escape-test');return page}
  const page=await setup()
  await page.getByRole('button',{name:'Відкрити внутрішній',exact:true}).click()
  const input=page.getByRole('textbox',{name:'Поле списку',exact:true})
  await input.focus();await page.evaluate(()=>fixture.childHandles=true);await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(()=>fixture.closed),[],'Child-owned Escape must not reach modal')
  assert.equal(await page.evaluate(()=>fixture.childEvents),1)
  await page.evaluate(()=>{fixture.childHandles=false;const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});event.preventDefault();window.dispatchEvent(event);window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}))})
  assert.deepEqual(await page.evaluate(()=>fixture.closed),[],'Consumed/IME key must not close dialogs')
  await page.evaluate(()=>fixture.busy(true));await page.getByRole('button',{name:'Остання кнопка',exact:true}).locator('xpath=self::*[@disabled]').waitFor();await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(()=>fixture.closed),[],'Busy top dialog must also protect underlying dialog')
  await page.evaluate(()=>fixture.busy(false));await page.getByRole('button',{name:'Остання кнопка',exact:true}).locator('xpath=self::*[not(@disabled)]').waitFor();await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(()=>fixture.closed),['inner'])
  await page.getByRole('button',{name:'Відкрити внутрішній',exact:true}).focus();await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button',{name:'Закрити',exact:true}).evaluate(el=>el===document.activeElement),true,'Focus trap remains intact')
  await page.keyboard.press('Escape');assert.deepEqual(await page.evaluate(()=>fixture.closed),['inner','outer'])
  passed.push('top-dialog ownership, busy top, child dropdown, defaultPrevented, IME, focus trap');await page.close()
  for(const screen of ['cash','suspend']){
    const page=await setup(screen)
    if(screen==='cash'){await page.getByLabel('Сума (грн) *',{exact:true}).fill('100');await page.locator('button[type=submit]').click()}
    else await page.getByRole('button',{name:'Відкласти',exact:true}).click()
    await page.waitForFunction(()=>fixture.writes.length===1)
    await page.keyboard.press('Escape')
    if(screen==='cash')await page.getByRole('button',{name:'Закрити',exact:true}).click()
    await page.locator('.absolute.inset-0').click({position:{x:2,y:2},force:true})
    assert.deepEqual(await page.evaluate(()=>fixture.closed),[],screen+' must stay open while financial operation is pending')
    await page.evaluate(()=>fixture.release());await page.waitForFunction(()=>fixture.closed.length===1)
    assert.equal(await page.evaluate(()=>fixture.writes.length),1)
    passed.push(screen+': Escape/backdrop/close cannot dismiss pending operation; one write');await page.close()
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);console.log(JSON.stringify({passed:true,cases:passed,liveWrites:0,printing:0,externalRequests:0}))
}finally{await browser?.close();await server.close()}
