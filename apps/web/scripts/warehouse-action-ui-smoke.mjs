// Real warehouse screens; synthetic APIs only, no live data or remote requests.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const mocks = {
  '@/components/Layout': 'export function Layout({children,title,actions,onBack}){return <main><h1>{title}</h1>{onBack&&<button onClick={onBack}>Назад</button>}{actions}{children}</main>}',
  '@/components/ui/Toast': 'export const toast={success:m=>fixture.success.push(m),error:m=>fixture.errors.push(m)};export function ToastContainer(){return null}',
  '@/stores/authStore': 'export const useAuthStore=select=>select({session:{user:{id:"owner",app_metadata:{role:"owner"}}}})',
  '@/features/products/productApi': 'export const productApi=fixture.products',
  '@/features/customers/customerApi': 'export const customerApi=fixture.customers',
  '@/features/inventory/warehouseApi': 'export const warehouseApi=fixture.warehouse',
  '@/features/inventory/writeoffApi': 'export const writeoffApi=fixture.writeoffs',
}
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,useNavigate,useLocation} from 'react-router-dom';
import Reserves from '/src/features/inventory/ReservesList.tsx';import Movements from '/src/features/inventory/WarehouseMovementPage.tsx';import Consumptions from '/src/features/inventory/InternalConsumptionsPage.tsx';import Writeoffs from '/src/features/inventory/WriteoffsPage.tsx';import Writeoff from '/src/features/inventory/WriteoffDetailPage.tsx';
function App(){fixture.nav=useNavigate();return <><output data-testid="location">{useLocation().pathname}</output><Routes>
<Route path="/reserves" element={<Reserves/>}/><Route path="/movements" element={<Movements/>}/><Route path="/consumptions" element={<Consumptions/>}/><Route path="/inventory/writeoffs" element={<Writeoffs/>}/><Route path="/inventory/writeoffs/:id" element={<Writeoff/>}/><Route path="*" element={<p>Other page</p>}/></Routes></>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[new URL(location.href).searchParams.get('page')||'/reserves']}><App/></MemoryRouter>);`
const bootstrap = `
window.fixture={success:[],errors:[],writes:[],reads:{},gates:{},hold:{},fail:{}};
fixture.failReads=new URL(location.href).searchParams.has('failReads');
fixture.wait=key=>fixture.hold[key]?new Promise((resolve,reject)=>fixture.gates[key]={resolve,reject}):Promise.resolve();
fixture.read=async key=>{fixture.reads[key]=(fixture.reads[key]||0)+1;await fixture.wait(key);if(fixture.failReads||fixture.fail[key])throw Error('Read failed: '+key)};
fixture.write=async(key,body)=>{fixture.writes.push({key,body});await fixture.wait(key);if(fixture.fail[key])throw Error('Write failed: '+key);return {id:'saved'}};
fixture.product={id:'p',name:'Тестова олива',sku:'OIL',unit:'л',qty_on_hand:8,qty_available:5,storage_bin:'A',purchase_price:123};
fixture.products={list:async({search})=>{await fixture.read('search:'+search);return {data:[{...fixture.product,name:search==='other'?'Інший товар':fixture.product.name}]}}};
fixture.customers={list:async()=>{await fixture.read('customer');return {data:[]}}};
fixture.reserves=[{id:'r',product_id:'p',qty:1,order_id:null,expires_at:null,created_at:'2026-09-26T08:00:00Z',product:fixture.product}];
fixture.warehouse={
pendingOperations:kind=>JSON.parse(localStorage.getItem('fixture-pending-'+kind)||'[]'),
resolveOperation:async(kind,id)=>{await fixture.read('resolve');localStorage.removeItem('fixture-pending-'+kind);return fixture.resolution||{status:'not_committed'}},
listReserves:async()=>{await fixture.read('reserves');return {data:fixture.reserves}},
createReserve:body=>fixture.write('reserve',body),releaseReserve:id=>fixture.write('release',{id}),
listMovements:async()=>{await fixture.read('movements');return {data:[],pagination:{total_pages:1}}},
createMovement:body=>fixture.write('movement',body),
listConsumptions:async()=>{await fixture.read('consumptions');return {data:[],summary:[],employees:[{id:'e',full_name:'Тестовий працівник',role:'manager'}]}},
createConsumption:body=>fixture.write('consumption',body)};
fixture.writeoffs={list:async body=>{await fixture.read('writeoffs');fixture.lastWriteoffQuery=body;return {data:[],pagination:{total:0,total_pages:3,page:body.page}}},
get:async id=>{await fixture.read('writeoff:'+id);return {data:{id,reason:'damage',created_at:'2026-09-26T08:00:00Z',notes:'Документ '+id,items:[]}}}};
`
const server = await createServer({cacheDir:createSmokeCache(),
  configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},
  resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},
  plugins:[{name:'warehouse-fixture',enforce:'pre',
    resolveId(id){if(id==='virtual:warehouse.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
    async load(id){
      if(id==='\0virtual:warehouse.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})
      let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
      for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
      if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
    },
    configureServer(server){server.middlewares.use('/warehouse-test',async(_req,res)=>{
      res.setHeader('content-type','text/html; charset=utf-8')
      res.end(await server.transformIndexHtml('/warehouse-test','<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:warehouse.tsx"></script></body></html>'))
    })},
  }],
})
let browser
try {
  await server.listen()
  browser=await chromium.launch({headless:true})
  const base=server.resolvedUrls.local[0],page=await browser.newPage(),errors=[],blocked=[]
  page.setDefaultTimeout(10000)
  page.on('pageerror',e=>errors.push(e.message))
  page.on('dialog',d=>d.accept())
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue()
    blocked.push(route.request().url());return route.abort()
  })
  const reset=async(path,extra='')=>{await page.goto(base+'warehouse-test?page='+encodeURIComponent(path)+extra)}
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const twice=button=>button.evaluate(e=>{e.click();e.click()})
  const dialog=()=>page.getByRole('dialog')
  const choose=async placeholder=>{
    await page.getByPlaceholder(placeholder).fill('oil')
    await dialog().getByRole('button',{name:/Тестова олива/}).click()
  }
  // Read failures are not empty business records, and retry reads only.
  for(const route of ['/reserves','/movements','/consumptions','/inventory/writeoffs']){
    await reset(route,'&failReads')
    await page.getByRole('button',{name:'Повторити',exact:true}).waitFor()
    assert.equal(await page.getByText('Немає активних резервів',{exact:true}).count(),0)
    assert.equal(await page.getByText('Актів списання немає',{exact:true}).count(),0)
    assert.equal(await page.getByText('Переміщень ще немає',{exact:true}).count(),0)
    await page.evaluate(()=>fixture.failReads=false)
    await page.getByRole('button',{name:'Повторити',exact:true}).click()
    await page.waitForFunction(()=>!document.body.textContent.includes('Повторити'))
    assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  }
  // A failed detail read stays on the same document, no false "not found"/redirect.
  await reset('/inventory/writeoffs/a','&failReads')
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByTestId('location').textContent(),'/inventory/writeoffs/a')
  await page.evaluate(()=>fixture.failReads=false)
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.getByText('Документ a',{exact:true}).waitFor()
  await page.evaluate(()=>{fixture.hold['writeoff:b']=true;fixture.nav('/inventory/writeoffs/b')})
  await page.waitForFunction(()=>fixture.gates['writeoff:b'])
  await page.evaluate(()=>fixture.nav('/inventory/writeoffs/c'))
  await page.getByText('Документ c',{exact:true}).waitFor()
  await page.evaluate(()=>fixture.gates['writeoff:b'].resolve())
  await settle()
  assert.equal(await page.getByText('Документ b',{exact:true}).count(),0)

  // Reserve: available stock, strict comma input, synchronous double submit, close guard.
  await reset('/reserves')
  await page.getByRole('button',{name:'Створити резерв',exact:true}).click()
  await choose('Введіть назву або SKU товару...')
  await dialog().getByText('SKU: OIL | Доступно: 5 л',{exact:true}).waitFor()
  await dialog().getByLabel('Кількість *',{exact:true}).fill('1e2')
  await dialog().locator('form').evaluate(e=>e.requestSubmit())
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  await dialog().getByLabel('Кількість *',{exact:true}).fill('1,125')
  await page.evaluate(()=>fixture.hold.reserve=true)
  await dialog().locator('form').evaluate(e=>{e.requestSubmit();e.requestSubmit()})
  await page.waitForFunction(()=>fixture.writes.length===1)
  assert.equal(await page.evaluate(()=>fixture.writes[0].body.qty),1.125)
  assert.equal(await dialog().getByLabel('Кількість *',{exact:true}).isDisabled(),true)
  await page.keyboard.press('Escape');assert.equal(await dialog().count(),1)
  await page.evaluate(()=>fixture.gates.reserve.reject(Error('No stock')))
  await page.waitForFunction(()=>!document.querySelector('fieldset').disabled)
  assert.equal(await dialog().getByLabel('Кількість *',{exact:true}).inputValue(),'1,125')
  // A successful write + failed list refresh must not offer another submission.
  await page.evaluate(()=>{fixture.hold.reserve=false;fixture.fail.reserves=true})
  await dialog().locator('form').evaluate(e=>e.requestSubmit())
  await page.getByRole('alert').filter({hasText:'завантажити резерви'}).waitFor()
  assert.equal(await dialog().count(),0)
  assert.equal(await page.evaluate(()=>fixture.writes.length),2)
  await page.evaluate(()=>fixture.fail.reserves=false)
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.locator('button[title="Скасувати ручний резерв"]').waitFor()

  // Cancel reserve cannot be repeated, and an old response cannot refresh a new page.
  await page.evaluate(()=>fixture.hold.release=true)
  await twice(page.locator('button[title="Скасувати ручний резерв"]'))
  await page.waitForFunction(()=>fixture.writes.filter(w=>w.key==='release').length===1)
  assert.equal(await page.getByRole('button',{name:'Створити резерв',exact:true}).isDisabled(),true)
  const reserveReads=await page.evaluate(()=>fixture.reads.reserves)
  const successes=await page.evaluate(()=>fixture.success.length)
  await page.evaluate(()=>fixture.nav('/other'))
  await page.getByText('Other page',{exact:true}).waitFor()
  await page.evaluate(()=>fixture.gates.release.resolve({ok:true}))
  await settle()
  assert.equal(await page.evaluate(()=>fixture.reads.reserves),reserveReads)
  assert.equal(await page.evaluate(()=>fixture.success.length),successes)

  // Search errors are recoverable, not a false "no product".
  await reset('/movements')
  await page.getByRole('button',{name:'Нове переміщення',exact:true}).click()
  await page.evaluate(()=>fixture.fail['search:oil']=true)
  await page.getByPlaceholder('Назва або артикул...').fill('oil')
  await dialog().getByRole('alert').waitFor()
  await page.evaluate(()=>fixture.fail['search:oil']=false)
  await dialog().getByRole('button',{name:'Повторити пошук',exact:true}).click()
  await dialog().getByRole('button',{name:/Тестова олива/}).click()
  await page.getByLabel('Нова комірка',{exact:true}).fill('B')
  await page.evaluate(()=>fixture.hold.movement=true)
  await twice(dialog().getByRole('button',{name:'Перемістити товар',exact:true}))
  await page.waitForFunction(()=>fixture.writes.length===1)
  assert.deepEqual(await page.evaluate(()=>fixture.writes[0].body),{product_id:'p',qty:8,from_bin:'A',to_bin:'B',note:null})
  await page.keyboard.press('Escape');assert.equal(await dialog().count(),1)
  await page.evaluate(()=>fixture.gates.movement.reject(Error('Stock changed')))
  await dialog().getByRole('alert').filter({hasText:'Stock changed'}).waitFor()
  assert.equal(await page.getByLabel('Нова комірка',{exact:true}).inputValue(),'B')
  await page.evaluate(()=>fixture.hold.movement=false)
  await dialog().getByRole('button',{name:'Перемістити товар',exact:true}).click()
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
  assert.equal(await page.evaluate(()=>fixture.success.length),1)

  // Consumption row searches are detached when the row is removed.
  await reset('/consumptions')
  await page.getByRole('button',{name:'Видати товар',exact:true}).click()
  await page.getByLabel('Співробітник',{exact:true}).selectOption('e')
  await page.evaluate(()=>fixture.hold['search:old']=true)
  await page.getByPlaceholder('Пошук товару по назві або артикулу...').fill('old')
  await page.waitForFunction(()=>fixture.gates['search:old'])
  await page.getByRole('button',{name:'Видалити рядок 1',exact:true}).click()
  await page.getByRole('button',{name:'Додати',exact:true}).click()
  await page.evaluate(()=>fixture.gates['search:old'].resolve())
  await settle()
  assert.equal(await dialog().getByRole('button',{name:/Тестова олива/}).count(),0)
  await choose('Пошук товару по назві або артикулу...')
  await page.getByLabel('Кількість: Тестова олива',{exact:true}).fill('0,5')
  await page.evaluate(()=>fixture.hold.consumption=true)
  await twice(dialog().getByRole('button',{name:'Зберегти та списати зі складу',exact:true}))
  await page.waitForFunction(()=>fixture.writes.length===1)
  assert.equal(await page.evaluate(()=>fixture.writes[0].body.items[0].qty),0.5)
  await page.keyboard.press('Escape');assert.equal(await dialog().count(),1)
  await page.evaluate(()=>fixture.gates.consumption.reject(Error('Insufficient stock')))
  await dialog().getByRole('alert').filter({hasText:'Insufficient stock'}).waitFor()
  assert.equal(await page.getByLabel('Кількість: Тестова олива',{exact:true}).inputValue(),'0,5')
  await page.evaluate(()=>fixture.hold.consumption=false)
  await dialog().getByRole('button',{name:'Зберегти та списати зі складу',exact:true}).click()
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
  assert.equal(await page.evaluate(()=>fixture.success.length),1)

  // Old create results for every form must not emit success or reload after leaving.
  for(const [route,open,placeholder,key,submit] of [
    ['/reserves','Створити резерв','Введіть назву або SKU товару...','reserve','Створити резерв'],
    ['/movements','Нове переміщення','Назва або артикул...','movement','Перемістити товар'],
    ['/consumptions','Видати товар','Пошук товару по назві або артикулу...','consumption','Зберегти та списати зі складу'],
  ]){
    await reset(route)
    await page.getByRole('button',{name:open,exact:true}).click()
    await choose(placeholder)
    if(key==='movement')await page.getByLabel('Нова комірка',{exact:true}).fill('B')
    if(key==='consumption')await page.getByLabel('Співробітник',{exact:true}).selectOption('e')
    await page.evaluate(key=>fixture.hold[key]=true,key)
    await dialog().getByRole('button',{name:submit,exact:true}).click()
    await page.waitForFunction(key=>fixture.gates[key],key)
    const reads=await page.evaluate(()=>JSON.stringify(fixture.reads))
    await page.evaluate(()=>fixture.nav('/other'))
    await page.getByText('Other page',{exact:true}).waitFor()
    await page.evaluate(key=>fixture.gates[key].resolve({id:'done'}),key)
    await settle()
    assert.equal(await page.evaluate(()=>fixture.success.length),0)
    assert.equal(await page.evaluate(()=>JSON.stringify(fixture.reads)),reads)
  }
  // Reason and page reset together rather than requesting the old page first.
  await reset('/inventory/writeoffs')
  await page.getByRole('button',{name:'→',exact:true}).click()
  await page.waitForFunction(()=>fixture.lastWriteoffQuery.page===2)
  await page.getByRole('button',{name:'Нестача',exact:true}).click()
  await page.waitForFunction(()=>fixture.lastWriteoffQuery.reason==='loss')
  assert.equal(await page.evaluate(()=>fixture.lastWriteoffQuery.page),1)
  assert.equal(await page.evaluate(()=>fixture.reads.writeoffs),3)
  // Pending intents survive a renderer reload; the only available action is reconciliation.
  for(const [route,key,open] of [
    ['/reserves','reserve','Створити резерв'],
    ['/movements','movement','Нове переміщення'],
    ['/consumptions','consumption','Видати товар'],
  ]){
    await reset(route)
    await page.evaluate(key=>localStorage.setItem('fixture-pending-'+key,JSON.stringify([{operationId:'pending-id',payload:{qty:2}}])),key)
    await page.reload()
    const check=page.getByRole('button',{name:'Перевірити операцію',exact:true})
    await check.waitFor()
    assert.equal(await page.getByRole('button',{name:open,exact:true}).isDisabled(),true)
    await page.evaluate(()=>fixture.fail.resolve=true)
    await check.click()
    await page.getByRole('alert').filter({hasText:'Read failed: resolve'}).waitFor()
    assert.equal(await page.evaluate(()=>fixture.writes.length),0)
    assert.equal(await page.getByRole('button',{name:open,exact:true}).isDisabled(),true)
    await page.evaluate(()=>{fixture.fail.resolve=false;fixture.resolution={status:'committed',result:{id:'already-saved'}}})
    await check.click()
    await page.getByText('Операцію вже збережено. Повторний запис не виконувався.',{exact:true}).waitFor()
    await page.waitForFunction(name=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===name&&!b.disabled),open)
    assert.equal(await page.evaluate(()=>fixture.writes.length),0)
    assert.equal(await page.evaluate(key=>localStorage.getItem('fixture-pending-'+key),key),null)
  }
  // A failed form keeps its inputs locked until a confirmed rollback; never resend on check.
  await reset('/consumptions')
  await page.getByRole('button',{name:'Видати товар',exact:true}).click()
  await page.getByLabel('Співробітник',{exact:true}).selectOption('e')
  await choose('Пошук товару по назві або артикулу...')
  await page.getByLabel('Кількість: Тестова олива',{exact:true}).fill('2,125')
  await page.evaluate(()=>fixture.hold.consumption=true)
  await dialog().getByRole('button',{name:'Зберегти та списати зі складу',exact:true}).click()
  await page.waitForFunction(()=>fixture.gates.consumption)
  await page.evaluate(()=>{localStorage.setItem('fixture-pending-consumption','[{"operationId":"uncertain","payload":{"qty":2.125}}]');fixture.gates.consumption.reject(Error('reply lost'))})
  await dialog().getByRole('button',{name:'Перевірити операцію',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Кількість: Тестова олива',{exact:true}).isDisabled(),true)
  await dialog().getByRole('button',{name:'Перевірити операцію',exact:true}).click()
  await page.waitForFunction(()=>!document.querySelector('fieldset').disabled)
  assert.equal(await page.getByLabel('Кількість: Тестова олива',{exact:true}).inputValue(),'2,125')
  assert.equal(await page.evaluate(()=>fixture.writes.length),1)
  // Absence is explicit, no retry writes are sent. Corrupt journals are retained and blocked.
  await reset('/reserves')
  await page.evaluate(()=>localStorage.setItem('fixture-pending-reserve','[{"operationId":"absent","payload":{}}]'))
  await page.reload()
  await page.getByRole('button',{name:'Перевірити операцію',exact:true}).click()
  await page.getByText('Попередню спробу не проведено. Можна перевірити дані та зберегти.',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  await page.evaluate(()=>localStorage.setItem('fixture-pending-reserve','{broken'))
  await page.reload()
  await page.getByRole('button',{name:'Перевірити операцію',exact:true}).click()
  assert.equal(await page.evaluate(()=>localStorage.getItem('fixture-pending-reserve')),'{broken')
  assert.equal(await page.getByRole('button',{name:'Створити резерв',exact:true}).isDisabled(),true)
  await page.evaluate(()=>localStorage.clear())
  // A late reconciliation result cannot refresh an unrelated page.
  await page.evaluate(()=>localStorage.setItem('fixture-pending-reserve','[{"operationId":"late","payload":{}}]'))
  await page.reload()
  await page.evaluate(()=>fixture.hold.resolve=true)
  await page.getByRole('button',{name:'Перевірити операцію',exact:true}).click()
  await page.waitForFunction(()=>fixture.gates.resolve)
  const oldReads=await page.evaluate(()=>fixture.reads.reserves)
  await page.evaluate(()=>fixture.nav('/other'))
  await page.getByText('Other page',{exact:true}).waitFor()
  await page.evaluate(()=>fixture.gates.resolve.resolve())
  await settle()
  assert.equal(await page.evaluate(()=>fixture.reads.reserves),oldReads)
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  assert.deepEqual(errors,[])
  assert.deepEqual(blocked,[])
  console.log('Warehouse UI: 22 scenario groups passed; recovery across reload, preserved uncertain form, no duplicate writes, no live DB/network or page errors.')
} finally {await browser?.close();await server.close()}
