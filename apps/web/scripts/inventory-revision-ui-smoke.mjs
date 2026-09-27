// Real inventory screen, synthetic data and no external connections.
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
  '@/features/inventory/inventoryApi':'export const inventoryApi=window.fixture.api',
  '@/features/admin/adminApi':'export const adminApi={getSettings:async()=>({data:{quick_percents:[]}}),listCategories:async()=>({data:[]})}',
  '@/features/admin/pricingApi':'export const pricingApi={}',
  '@/features/products/productApi':'export const productApi={}',
  '@/features/labels/LabelDesigner':'export const loadProductLabelSettings=()=>({});export const printLabels=()=>{throw Error("Unexpected print")}',
  '@/features/pos/CameraScanner':'export function CameraScanner(){return null}',
  '@/features/pos/usePOSBarcodeScanner':'export const usePOSBarcodeScanner=()=>{}',
  '@/lib/audioService':'export const playErrorTone=()=>{};export const playSuccessBeep=()=>{};export const initAudio=()=>{}',
  '@/stores/authStore':'export const useAuthStore=s=>s({session:{user:{id:"owner",app_metadata:{role:"owner"}}}})',
  '@/components/Layout':'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/components/ui/Toast':'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export function ToastContainer(){return null}',
}
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';import ActiveSession from '/src/features/inventory/ActiveSession.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/inventory/test']}><Routes><Route path='/inventory/:id' element={<ActiveSession/>}/></Routes></MemoryRouter>);`
const bootstrap=`window.forsageDesktop={};window.fixture={errors:[],warnings:[],messages:[],writes:[],productWrites:[],complete:0};
fixture.item=JSON.parse(sessionStorage.getItem('db-item')||'null')||{id:'item',product_id:'p',counted_stock:46,expected_stock:12,edit_revision:'r1',price_checked:true,observed_retail_price:null,updated_at:'2026-09-23T12:00:00Z',product:{id:'p',sku:'CIRCLE',name:'Тестовий круг',barcode:'2000177521924',unit:'шт',retail_price:1500,purchase_price:1000}};
fixture.revision=()=>JSON.stringify([fixture.removed,fixture.item]);
fixture.api={pendingScans:()=>[],getSession:async()=>({data:{id:'test',name:'Тест',status:'in_progress',edit_revision:fixture.revision(),items:fixture.removed?[]:[structuredClone(fixture.item)],price_issues:[],my_entries:[],summary:{total_products:1,counted_products:fixture.removed?0:1,matching_products:0,discrepancy_products:1,price_checked_products:1,price_mismatch_products:0,participants:1,total_expected_units:12,total_counted_units:fixture.item.counted_stock}}}),
setItemQty:async(id,itemId,qty,opts)=>{fixture.writes.push({qty,revision:opts.expectedRevision});if(fixture.hold)await new Promise(r=>fixture.release=r);if(fixture.fail)throw Error('Тестова відмова запису');if(opts.expectedRevision!==fixture.item.edit_revision)throw Error('DOCUMENT_CONFLICT: Позиція змінилася');fixture.item.counted_stock=qty;fixture.item.edit_revision='r'+(Number(fixture.item.edit_revision.slice(1))+1);sessionStorage.setItem('db-item',JSON.stringify(fixture.item));return {data:structuredClone(fixture.item)}},
updateProducts:async(id,edits)=>{fixture.productWrites.push(structuredClone(edits));if(fixture.productHold)await new Promise(r=>fixture.releaseProduct=r);if(fixture.productFail)throw Error('Тестова відмова запису товару');for(const edit of edits){for(const key of Object.keys(edit.base))if(fixture.item.product[key]!==edit.base[key]&&fixture.item.product[key]!==edit.values[key])throw Error('DOCUMENT_CONFLICT: Товар змінився');Object.assign(fixture.item.product,edit.values)}sessionStorage.setItem('db-item',JSON.stringify(fixture.item));return [structuredClone(fixture.item.product)]},
removeItem:async(id,itemId,opts)=>{if(opts.expectedRevision!==fixture.item.edit_revision)throw Error('DOCUMENT_CONFLICT: Позиція змінилася');fixture.removed=true;return {data:{ok:true}}},
complete:async(id,opts)=>{if(opts.expectedRevision!==fixture.revision())throw Error('DOCUMENT_CONFLICT: Ревізія змінилася');fixture.complete++;return {data:{items_updated:1}}}};`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[tailwindcss(),{
  name:'inventory-fixture',enforce:'pre',resolveId(id){if(id==='virtual:inventory-revision.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){if(id==='\0virtual:inventory-revision.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'});let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined;for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock;if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})},
  configureServer(server){server.middlewares.use('/inventory-revision-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/inventory-revision-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:inventory-revision.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],blocked=[],base=server.resolvedUrls.local[0]
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('dialog',d=>d.accept())
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():(blocked.push(route.request().url()),route.abort()))
  await page.goto(base+'inventory-revision-test')
  const input=page.getByRole('spinbutton',{name:'Фактична кількість'})
  await input.waitFor();await input.fill('98')
  await page.evaluate(()=>{fixture.item.counted_stock=56;fixture.item.edit_revision='r2';sessionStorage.setItem('db-item',JSON.stringify(fixture.item))})
  await input.blur();await page.getByRole('button',{name:'Звірив — зберегти моє'}).waitFor()
  assert.equal(await input.inputValue(),'98')
  assert.equal(await page.evaluate(()=>fixture.item.counted_stock),56)
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('forsage:inventory:test:active-draft:v1'))?.rowQuantityDrafts?.item?.value==='98')
  await page.reload();await input.waitFor()
  assert.equal(await input.inputValue(),'98')
  await page.getByRole('button',{name:'Завершити та застосувати залишки',exact:true}).click()
  await page.getByRole('button',{name:'Так, завершити',exact:true}).click()
  await page.waitForFunction(()=>fixture.errors.some(m=>m.includes('незбережена')))
  assert.equal(await page.evaluate(()=>fixture.complete),0)
  await page.getByRole('button',{name:'Ні',exact:true}).click()
  await page.getByRole('button',{name:'Звірив — зберегти моє'}).click()
  await page.waitForFunction(()=>fixture.item.counted_stock===98)
  assert.equal(await input.inputValue(),'98')
  assert.deepEqual(await page.evaluate(()=>fixture.writes),[{qty:98,revision:'r2'}])
  await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('forsage:inventory:test:active-draft:v1'))?.rowQuantityDrafts?.item)
  // While a save is pending, a second blur cannot enqueue another absolute write.
  await page.evaluate(()=>fixture.hold=true);await input.fill('100');await input.blur()
  await page.waitForFunction(()=>typeof fixture.release==='function')
  assert.equal(await input.isDisabled(),true)
  await page.evaluate(()=>{fixture.hold=false;fixture.release()})
  await page.waitForFunction(()=>fixture.item.counted_stock===100)
  assert.equal(await input.inputValue(),'100')
  assert.equal(await page.evaluate(()=>fixture.writes.length),2)
  // Failure keeps the value, explicit discard accepts DB quantity and unblocks completion.
  await page.evaluate(()=>fixture.fail=true);await input.fill('101');await input.blur()
  await page.getByRole('button',{name:'Повторити',exact:true}).waitFor()
  assert.equal(await input.inputValue(),'101')
  await page.getByRole('button',{name:'Взяти з бази',exact:true}).click()
  assert.equal(await input.inputValue(),'100')
  // Product fields preserve the original baseline, not a later background value.
  const retail=page.getByRole('spinbutton',{name:'Ціна продажу',exact:true})
  const name=page.getByRole('textbox',{name:'Назва товару',exact:true})
  await retail.fill('25.00')
  await page.evaluate(()=>{fixture.item.product.retail_price=1800;sessionStorage.setItem('db-item',JSON.stringify(fixture.item))})
  await retail.blur();await page.getByRole('button',{name:'Звірив — зберегти моє'}).waitFor()
  assert.equal(await retail.inputValue(),'25.00')
  assert.equal(await page.evaluate(()=>fixture.item.product.retail_price),1800)
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('forsage:inventory:test:active-draft:v1'))?.rowProductDrafts?.item?.retail_price?.base===1500)
  await page.reload();await retail.waitFor()
  assert.equal(await retail.inputValue(),'25.00')
  await page.getByRole('button',{name:'Звірив — зберегти моє'}).click()
  await page.waitForFunction(()=>fixture.item.product.retail_price===2500)
  await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('forsage:inventory:test:active-draft:v1'))?.rowProductDrafts?.item)
  // Failed name save stays visible; discard has no database write.
  await page.evaluate(()=>fixture.productFail=true)
  await name.fill('Незбережена назва');await name.blur()
  await page.getByRole('button',{name:'Повторити',exact:true}).waitFor()
  assert.equal(await name.inputValue(),'Незбережена назва')
  await page.getByRole('button',{name:'Взяти з бази',exact:true}).click()
  assert.equal(await name.inputValue(),'Тестовий круг')
  // A pending product edit cannot send a duplicate write.
  await page.evaluate(()=>{fixture.productFail=false;fixture.productHold=true})
  const sku=page.getByRole('textbox',{name:'Артикул',exact:true})
  await sku.fill('CIRCLE-NEW');await sku.blur()
  await page.waitForFunction(()=>typeof fixture.releaseProduct==='function')
  assert.equal(await sku.isDisabled(),true)
  await page.evaluate(()=>{fixture.productHold=false;fixture.releaseProduct()})
  await page.waitForFunction(()=>fixture.item.product.sku==='CIRCLE-NEW')
  assert.equal(await page.evaluate(()=>fixture.productWrites.filter(edits=>edits[0].values.sku).length),1)
  // Removing a stale row must not erase newer counts or a failed field draft.
  await page.evaluate(()=>fixture.productFail=true);await name.fill('Введене до видалення');await name.blur()
  await page.getByRole('button',{name:'Повторити',exact:true}).waitFor()
  await page.evaluate(()=>fixture.item.edit_revision='changed-after-view')
  await page.getByRole('button',{name:'Прибрати',exact:true}).click()
  await page.waitForFunction(()=>fixture.errors.some(m=>m.includes('Позиція змінилася')))
  assert.equal(await name.inputValue(),'Введене до видалення')
  // A row removed elsewhere leaves an accessible draft, with explicit discard.
  await page.evaluate(()=>fixture.removed=true)
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.getByRole('button',{name:'Відкинути правки прибраного рядка',exact:true}).waitFor()
  assert.equal(await page.getByText('Назва: Введене до видалення',{exact:true}).count(),1)
  await page.getByRole('button',{name:'Відкинути правки прибраного рядка',exact:true}).click()
  await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('forsage:inventory:test:active-draft:v1'))?.rowProductDrafts?.item)
  // Completion must use exactly the version shown when confirmation opened.
  await page.getByRole('button',{name:'Завершити та застосувати залишки',exact:true}).click()
  await page.evaluate(()=>fixture.item.counted_stock=101)
  await page.getByRole('button',{name:'Так, завершити',exact:true}).click()
  await page.waitForFunction(()=>fixture.errors.some(m=>m.includes('Ревізія змінилася')))
  assert.equal(await page.evaluate(()=>fixture.complete),0)
  await page.getByRole('button',{name:'Так, завершити',exact:true}).waitFor({state:'hidden'})
  await page.getByRole('button',{name:'Завершити та застосувати залишки',exact:true}).click()
  await page.getByRole('button',{name:'Так, завершити',exact:true}).click()
  await page.waitForFunction(()=>fixture.complete===1)
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: inventory count/product drafts survive conflicts and reload; pending edits locked; stale deletion rejected; orphan drafts visible; completion requires reviewed snapshot; explicit discard does not write')
}finally{await browser?.close();await server.close()}
