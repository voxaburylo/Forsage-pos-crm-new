// Real catalogue component with synthetic data only; all external requests blocked.
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
  '@/features/products/productApi': 'export const productApi=fixture.api',
  '@/features/admin/adminApi': 'export const adminApi={}',
  '@/features/products/MergeModal': 'export function MergeModal(){return null}',
  '@/features/products/ImportModal': 'export function ImportModal(){return null}',
  '@/features/products/BulkEditModal': 'export function BulkEditModal(){return null}',
  '@/features/labels/LabelDesigner': 'export const printLabels=()=>{};export const loadProductLabelSettings=()=>({})',
  '@/features/pos/usePOSBarcodeScanner': 'export const usePOSBarcodeScanner=()=>{}',
  '@/stores/authStore': 'export const useAuthStore=selector=>selector({session:{user:{id:"test",app_metadata:{role:fixture.role}}}})',
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>fixture.desktop',
  '@/lib/offlineDB': 'export const getCachedBrands=async()=>[];export const getCachedCategories=async()=>[];export const listProductsOffline=()=>{throw Error("Unexpected cache access")}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),success:m=>fixture.success.push(m)};export function ToastContainer(){return null}',
  '@/components/Layout': 'export function Layout({children,title,actions}){return <main id="app-main-scroll"><h1>{title}</h1>{actions}{children}</main>}',
  '@/lib/apiBaseUrl': 'export const API_BASE_URL="https://blocked.invalid"',
}
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import ProductsPage from '/src/features/products/ProductsPage.tsx';
const root=createRoot(document.getElementById('root'));let version=0;fixture.mount=()=>root.render(<MemoryRouter key={version++}><ProductsPage/></MemoryRouter>);fixture.mount();`
const bootstrap = `window.fixture={errors:[],success:[],writes:[],queries:[],desktop:true,role:'owner'};
fixture.products=[1,2].map(n=>({id:'p'+n,name:'Тестовий товар '+n,sku:'TEST'+n,barcode:'200000000000'+n,retail_price:n*10000,purchase_price:5000,qty_on_hand:3,reorder_point:0,unit:'шт',is_active:true,storage_bin:'A-'+n,cross_numbers_count:0}));
fixture.bridge={catalog:{listCategories:async()=>[],listBrands:async()=>[]}};
fixture.api={list:async q=>{fixture.queries.push(q);return {data:structuredClone([fixture.products[q.page-1]]),pagination:{page:q.page,per_page:1,total:2,total_pages:2}}},update:async(id,patch)=>{fixture.writes.push({id,patch});await new Promise(r=>setTimeout(r,120));if(fixture.fail)throw Error('Збереження не виконано');const p=fixture.products.find(p=>p.id===id);Object.assign(p,patch.retail_price!==undefined?{retail_price:Math.round(Number(patch.retail_price)*100)}:patch);return {data:structuredClone(p)}}};`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'catalog-edit-fixture',enforce:'pre',resolveId(id){if(id==='virtual:catalog-edit.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){
    if(id==='\0virtual:catalog-edit.tsx')return transformWithEsbuild(entry,'catalog-edit.tsx',{loader:'tsx',jsx:'automatic'})
    let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
    for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
    if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
  },configureServer(server){server.middlewares.use('/catalog-edit-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/catalog-edit-test','<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:catalog-edit.tsx"></script></body></html>'))})},
}]})
let browser
try {
  await server.listen();browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],blocked=[]
  page.on('pageerror',e=>errors.push(e.message));const base=server.resolvedUrls.local[0]
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();blocked.push(route.request().url());return route.abort()})
  await page.goto(base+'catalog-edit-test')
  await page.getByRole('button',{name:'Тестовий товар 2',exact:true}).waitFor()
  const first=page.locator('tr').filter({has:page.getByRole('button',{name:'Тестовий товар 1',exact:true})})
  await first.getByTitle('Клік — змінити ціну').click()
  const price=page.getByLabel('Ціна: Тестовий товар 1')
  await price.fill('1 250,50');await price.press('Enter')
  await first.getByTitle('Клік — змінити ціну').filter({hasText:'1250.50'}).waitFor()
  assert.deepEqual(await page.evaluate(()=>fixture.writes),[{id:'p1',patch:{retail_price:'1250.50'}}])
  await first.getByTitle('Клік — змінити комірку').click()
  await page.getByLabel('Комірка: Тестовий товар 1').fill('B-98');await page.getByLabel('Комірка: Тестовий товар 1').press('Enter')
  await first.getByTitle('Клік — змінити комірку').filter({hasText:'B-98'}).waitFor()
  await first.getByTitle('Клік — змінити ціну').click();await price.fill('')
  await price.press('Enter');assert.equal(await page.evaluate(()=>fixture.writes.length),2)
  await price.fill('12 грн 3');await price.press('Enter');assert.equal(await page.evaluate(()=>fixture.writes.length),2)
  await page.evaluate(()=>fixture.fail=true);await price.fill('1300');await price.press('Enter')
  await page.waitForFunction(()=>fixture.errors.includes('Збереження не виконано'))
  assert.equal(await price.inputValue(),'1300')
  await page.evaluate(()=>fixture.fail=false);await price.press('Enter')
  await first.getByTitle('Клік — змінити ціну').filter({hasText:'1300.00'}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.writes.length),4)
  await first.getByTitle('Клік — змінити ціну').click();await price.fill('9999');await price.press('Escape')
  await first.getByTitle('Клік — змінити ціну').filter({hasText:'1300.00'}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.writes.length),4)
  await page.evaluate(()=>{fixture.role='cashier';fixture.mount()})
  await page.getByRole('button',{name:'Тестовий товар 1',exact:true}).waitFor()
  assert.equal(await first.getByTitle('Ціна',{exact:true}).isDisabled(),true)
  assert.equal(await first.getByTitle('Комірка',{exact:true}).isDisabled(),true)
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
  console.log('PASS: earlier loaded page updates, decimal/grouped price, no Enter/blur duplicate, blank/malformed values rejected, failed save retained/retried, Escape cancels, read-only controls')
} finally {await browser?.close();await server.close()}
