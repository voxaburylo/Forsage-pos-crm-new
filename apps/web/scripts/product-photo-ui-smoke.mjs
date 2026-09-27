// Real product cards/photos, browser decoding and synthetic persistence; no business data/network.
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
  '@/lib/desktopBridge': 'export const isDesktopRuntime=()=>!fixture.web;export const desktopBridge=()=>({catalog:{savePhoto:fixture.savePhoto}})',
  '@/components/ui/Toast': 'export const toast={success:m=>fixture.success.push(m),error:m=>fixture.errors.push(m),warning:m=>fixture.errors.push(m)};export function ToastContainer(){return null}',
  '@/features/products/productApi': 'export const productApi=fixture.api',
  '@/features/admin/adminApi': 'export const adminApi=fixture.admin',
  '@/features/admin/pricingApi': 'export const pricingApi=fixture.pricing',
  '@/features/labels/LabelDesigner': 'export const printLabels=()=>{};export const loadProductLabelSettings=()=>({});export const DEFAULT_BIN_LABEL={}',
  '@/features/inventory/warehouseApi': 'export const warehouseApi=fixture.warehouse',
  '@/stores/authStore': 'export const useAuthStore=select=>select({session:{user:{app_metadata:{role:fixture.role}}},offlineMode:fixture.offline})',
  '@/components/Layout': 'export function Layout({children,title,actions}){return <main><h1>{title}</h1>{actions}{children}</main>}',
}
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,useNavigate} from 'react-router-dom';import {ProductPhotoUpload} from '/src/features/products/ProductPhotoUpload.tsx';import ProductDetail from '/src/features/products/ProductDetailPage.tsx';import ProductForm from '/src/features/products/ProductFormPage.tsx';
function Cards(){fixture.nav=useNavigate();return <Routes><Route path="/products/new" element={<ProductForm/>}/><Route path="/products/:id/edit" element={<ProductForm/>}/><Route path="/products/:id" element={<ProductDetail/>}/><Route path="*" element={<p>List</p>}/></Routes>}
const root=createRoot(document.getElementById('root'));fixture.render=()=>root.render(fixture.mode==='photo'?(fixture.hidden?null:<ProductPhotoUpload productId={fixture.id} currentPhotoUrl={fixture.photos[fixture.id]||null} disabled={fixture.disabled} onBusyChange={fixture.busyChange} onPhotoUrl={fixture.commitFor(fixture.id)}/>):<MemoryRouter initialEntries={[fixture.mode==='detail'?'/products/a':'/products/a/edit']}><Cards/></MemoryRouter>);fixture.render();`
const bootstrap = `
window.fixture={id:'a',disabled:false,hidden:false,photos:{},success:[],errors:[],writes:[],uploads:[],busy:[],gates:{},hold:{}};
fixture.mode=new URL(location.href).searchParams.get('mode')||'photo';fixture.web=new URL(location.href).searchParams.has('web');fixture.detailWrites=[];fixture.crosses={a:[],b:[]};
fixture.role=new URL(location.href).searchParams.get('role')||'owner';fixture.offline=new URL(location.href).searchParams.has('offline');
fixture.failRefs=new URL(location.href).searchParams.has('failRefs');fixture.refWrites=[];fixture.barcodeCalls=0;fixture.priceCalls=[];fixture.suggestedPrice=15000;
fixture.wait=key=>fixture.hold[key]?new Promise((resolve,reject)=>fixture.gates[key]={resolve,reject}):Promise.resolve();
fixture.admin={
 listCategories:async()=>{if(fixture.failRefs)throw Error('Reference read failed');return {data:[]}},
 listBrands:async()=>({data:[]}),getSettings:async()=>({data:{quick_percents:[25]}}),
 createCategory:async name=>{fixture.refWrites.push({kind:'category',name});await fixture.wait('ref-category');return {data:{id:'cat-new',name}}},
 createBrand:async name=>{fixture.refWrites.push({kind:'brand',name});await fixture.wait('ref-brand');return {data:{id:'brand-new',name}}},
};
fixture.pricing={autoRetail:async(...args)=>{fixture.priceCalls.push(args);await fixture.wait('price');return {data:{retail_price:fixture.suggestedPrice}}}};
fixture.busyChange=value=>fixture.busy.push(value);
fixture.savePhoto=async(folder,bytes)=>{fixture.uploads.push({folder,size:bytes.byteLength});await fixture.wait('upload-'+folder);return fixture.image+'#'+folder};
fixture.commitFor=id=>async url=>{fixture.writes.push({id,url});await fixture.wait('commit-'+id);fixture.photos[id]=url;fixture.render()};
fixture.change=id=>{fixture.id=id;fixture.render()};
const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);fixture.image=canvas.toDataURL('image/png');
fixture.getImage=async()=>new Blob([Uint8Array.from(atob(fixture.image.split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});
fixture.products=Object.fromEntries(['a','b'].map(id=>[id,{id,name:'Product '+id,sku:'SKU-'+id,barcode:null,unit:'шт',retail_price:12000,purchase_price:6000,qty_on_hand:2,reorder_point:0,is_active:true,created_at:'2026-09-25',updated_at:'2026-09-25',photo_url:fixture.image+'#'+id}]));
fixture.api={
 get:async id=>{await fixture.wait('get-'+id);return {data:structuredClone(fixture.products[id])}},
 getHistory:async id=>{await fixture.wait('history-'+id);return {data:[]}},
 getAnalogs:async id=>{if(fixture.failLinks)throw Error('links failed');await fixture.wait('analogs-'+id);return {grouped:fixture.crosses[id].length?{standard:[fixture.products[id==='a'?'b':'a']]}:{}}},
 getFitment:async()=>null,getCobuy:async()=>[],
 getCrossNumbers:async id=>{if(fixture.failLinks)throw Error('links failed');await fixture.wait('crosses-'+id);return {data:structuredClone(fixture.crosses[id])}},
 addCrossNumbers:async(id,numbers,source)=>{fixture.detailWrites.push({kind:'cross-add',id,numbers,source});await fixture.wait('cross-add');fixture.crosses[id]=numbers.map((number,i)=>({id:'cross-'+i,number,source,number_type:'cross'}));return {data:structuredClone(fixture.crosses[id])}},
 removeCrossNumber:async(id,crossId)=>{fixture.detailWrites.push({kind:'cross-remove',id,crossId});await fixture.wait('cross-remove');fixture.crosses[id]=fixture.crosses[id].filter(x=>x.id!==crossId);return {data:structuredClone(fixture.crosses[id])}},
 delete:async id=>{fixture.detailWrites.push({kind:'delete',id});await fixture.wait('delete')},
 generateBarcode:async id=>{fixture.detailWrites.push({kind:'barcode',id});await fixture.wait('detail-barcode');return {data:{...fixture.products[id],barcode:'2000000000123'}}},
 update:async(id,patch)=>{fixture.writes.push({id,patch});await fixture.wait('commit-'+id);Object.assign(fixture.products[id],patch);return {data:structuredClone(fixture.products[id])}},
 create:async patch=>{fixture.writes.push({id:'new',patch});await fixture.wait('commit-new');return {data:{id:'new',...patch}}},
 generateBarcodeOnly:async()=>{fixture.barcodeCalls++;await fixture.wait('barcode');return {data:{barcode:'2000000000123'}}},
};
fixture.warehouse={pendingOperations:()=>[],resolveOperation:async()=>({status:'not_committed'}),createReserve:async input=>{fixture.detailWrites.push({kind:'reserve',input});await fixture.wait('reserve');fixture.products[input.product_id].qty_available=2-input.qty;fixture.products[input.product_id].qty_reserved=input.qty}};
fixture.paste=async()=>{const data=new DataTransfer();data.items.add(new File([await fixture.getImage()],'test.png',{type:'image/png'}));const e=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});window.dispatchEvent(e);return e.defaultPrevented};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>{await fixture.wait('clipboard');return [{types:['image/png'],getType:async()=>{await fixture.wait('clipboard-type');return fixture.getImage()}}]}}});
`
const server=await createServer({cacheDir:createSmokeCache(),configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'photo-fixture',enforce:'pre',resolveId(id){if(id==='virtual:photo.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){
    if(id==='\0virtual:photo.tsx')return transformWithEsbuild(entry,'photo.tsx',{loader:'tsx',jsx:'automatic'})
    let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
    for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
    if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
  },configureServer(server){server.middlewares.use('/photo-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/photo-test','<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:photo.tsx"></script></body></html>'))})},
}]})
let browser
try{
  await server.listen();browser=await chromium.launch({headless:true})
  const page=await browser.newPage(), errors=[], blocked=[]
  page.on('pageerror',e=>errors.push(e.message));const base=server.resolvedUrls.local[0]
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();blocked.push(route.request().url());return route.abort()})
  const reset=async(mode='photo',extra='')=>{await page.goto(base+'photo-test?mode='+mode+extra);if(mode==='detail')await page.getByRole('heading',{name:'Product a',exact:true}).waitFor();else await page.getByRole('button',{name:'Вставити з буфера'}).waitFor()}
  const settle=async key=>{await page.evaluate(key=>{fixture.hold[key]=false;fixture.gates[key]?.resolve()},key)}
  const change=async id=>{await page.evaluate(id=>fixture.change(id),id);await page.waitForTimeout(40)}
  const paste=()=>page.evaluate(()=>fixture.paste())
  const pending=key=>page.waitForFunction(key=>!!fixture.gates[key],key)
  const ready=()=>page.waitForFunction(()=>document.querySelector('[aria-busy]')?.getAttribute('aria-busy')==='false')
  await reset()
  await page.evaluate(()=>fixture.hold['upload-a']=true);await paste();await pending('upload-a')
  await change('b');await ready()
  await page.evaluate(()=>fixture.hold['upload-b']=true);await paste();await pending('upload-b')
  await settle('upload-a');await page.waitForTimeout(40)
  assert.equal(await page.locator('[aria-busy]').getAttribute('aria-busy'),'true')
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  await settle('upload-b');await page.waitForFunction(()=>fixture.writes.length===1)
  assert.equal(await page.evaluate(()=>fixture.writes[0].id),'b')
  assert.deepEqual(await page.evaluate(()=>fixture.success),['Фото збережено'])
  console.log('PASS: changing the product during upload leaves the next card usable; no stale attachment')

  await reset()
  await page.evaluate(()=>fixture.hold['commit-a']=true)
  await page.evaluate(()=>Promise.all([fixture.paste(),fixture.paste()]))
  await pending('commit-a')
  assert.equal(await page.evaluate(()=>fixture.uploads.length),1)
  assert.equal(await paste(),false)
  assert.equal(await page.evaluate(()=>fixture.success.length),0)
  await settle('commit-a');await ready()
  assert.equal(await page.evaluate(()=>fixture.writes.length),1)
  assert.deepEqual(await page.evaluate(()=>fixture.busy),[true,false])
  assert.equal(await page.getByRole('img',{name:'Фото товару'}).count(),1)
  console.log('PASS: double paste is serialized through the final product save; success only after persistence')

  // A failed replacement keeps the old preview and can be explicitly retried.
  await page.evaluate(()=>{fixture.hold['commit-a']=true;fixture.gates={}})
  await paste();await pending('commit-a')
  await page.evaluate(()=>fixture.gates['commit-a'].reject(Error('Фото не збережено')))
  await ready()
  assert.equal(await page.getByRole('img',{name:'Фото товару'}).count(),1)
  assert.deepEqual(await page.evaluate(()=>fixture.errors),['Фото не збережено'])
  assert.equal(await page.evaluate(()=>fixture.success.length),1)
  await page.evaluate(()=>fixture.hold['commit-a']=false);await paste();await ready()
  assert.equal(await page.evaluate(()=>fixture.success.length),2)
  // Removal is serialized too; it clears a reference, it never re-uploads an image.
  const uploads=await page.evaluate(()=>fixture.uploads.length)
  await page.evaluate(()=>{fixture.hold['commit-a']=true;fixture.gates={}})
  await page.getByRole('button',{name:'Прибрати фото'}).evaluate(b=>{b.click();b.click()})
  await pending('commit-a')
  assert.equal(await page.evaluate(()=>fixture.writes.at(-1).url),null)
  assert.equal(await page.evaluate(()=>fixture.uploads.length),uploads)
  await settle('commit-a');await ready()
  assert.equal(await page.getByRole('img',{name:'Фото товару'}).count(),0)
  console.log('PASS: save failure keeps the photo, manual retry works, removal does not duplicate writes')

  for(const stage of ['clipboard','clipboard-type']){
    await reset()
    await page.evaluate(key=>fixture.hold[key]=true,stage)
    await page.getByRole('button',{name:'Вставити з буфера'}).click();await pending(stage)
    await change('b');await ready()
    await settle(stage);await page.waitForTimeout(60)
    assert.equal(await page.evaluate(()=>fixture.uploads.length),0)
    assert.equal(await page.evaluate(()=>fixture.errors.length+fixture.success.length),0)
    assert.deepEqual(await page.evaluate(()=>fixture.busy),[true,false])
    await paste();await page.waitForFunction(()=>fixture.writes.length===1)
    assert.equal(await page.evaluate(()=>fixture.writes[0].id),'b')
  }
  console.log('PASS: changing cards cancels clipboard read/getType before any upload; the new card still works')

  await reset()
  await page.evaluate(()=>fixture.hold['clipboard-type']=true)
  await page.getByRole('button',{name:'Вставити з буфера'}).click();await pending('clipboard-type')
  await page.waitForFunction(()=>fixture.errors.some(m=>m.includes('Немає відповіді')));await ready()
  await settle('clipboard-type');await page.waitForTimeout(60)
  assert.equal(await page.evaluate(()=>fixture.uploads.length),0)
  await paste();await page.waitForFunction(()=>fixture.writes.length===1)
  console.log('PASS: stalled clipboard image times out without a late write; retry succeeds')

  await reset()
  await page.evaluate(()=>fixture.hold['upload-a']=true);await paste();await pending('upload-a')
  await page.evaluate(()=>{fixture.hidden=true;fixture.render()})
  await page.waitForFunction(()=>!document.querySelector('[aria-busy]'))
  await settle('upload-a');await page.waitForTimeout(50)
  assert.equal(await page.evaluate(()=>fixture.writes.length+fixture.errors.length+fixture.success.length),0)
  assert.deepEqual(await page.evaluate(()=>fixture.busy),[true,false])
  assert.equal(await paste(),false)
  // Failure of an already sent save must not show an alert in a different card.
  await reset();await page.evaluate(()=>fixture.hold['commit-a']=true)
  await paste();await pending('commit-a')
  await change('b');await ready()
  await page.evaluate(()=>fixture.gates['commit-a'].reject(Error('Late write error')))
  await page.waitForTimeout(50)
  assert.deepEqual(await page.evaluate(()=>fixture.errors),[])
  assert.equal(await page.getByRole('img',{name:'Фото товару'}).count(),0)
  console.log('PASS: unmount removes paste listener; already sent writes cannot disturb another card')

  await reset()
  await page.evaluate(()=>{fixture.disabled=true;fixture.render()})
  await page.waitForFunction(()=>document.querySelector('button').disabled)
  assert.equal(await paste(),false)
  assert.equal(await page.evaluate(()=>fixture.uploads.length),0)
  await page.evaluate(()=>{fixture.disabled=false;fixture.render()});await page.waitForTimeout(30)
  // Broken image must release the pending flag and accept the next valid file.
  await page.locator('input[type=file]').first().setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('invalid image')})
  await page.waitForFunction(()=>fixture.errors.length===1);await ready()
  assert.equal(await page.evaluate(()=>fixture.uploads.length),0)
  await paste();await page.waitForFunction(()=>fixture.writes.length===1)
  console.log('PASS: disabled controls do not consume paste; broken-image failure unlocks the next attempt')

  await reset('detail')
  // The real detail route must never show A's card under B's ID during the next load.
  await page.evaluate(()=>{fixture.hold['get-b']=true;fixture.nav('/products/b')});await pending('get-b')
  assert.equal(await page.getByRole('heading',{name:'Product a',exact:true}).count(),0)
  await settle('get-b');await page.getByRole('heading',{name:'Product b',exact:true}).waitFor()
  await page.evaluate(()=>{fixture.hold['get-a']=true;fixture.nav('/products/a')});await pending('get-a')
  await page.evaluate(()=>fixture.nav('/products/b'));await page.getByRole('heading',{name:'Product b',exact:true}).waitFor()
  await page.evaluate(()=>fixture.gates['get-a'].reject(Error('Old load failed')));await page.waitForTimeout(60)
  assert.equal(await page.getByRole('heading',{name:'Product b',exact:true}).count(),1)
  await page.evaluate(()=>{fixture.hold['get-a']=true;fixture.nav('/products/a')});await pending('get-a')
  await page.evaluate(()=>fixture.nav('/products/b'));await page.getByRole('heading',{name:'Product b',exact:true}).waitFor()
  await settle('get-a');await page.waitForTimeout(60)
  assert.equal(await page.getByRole('heading',{name:'Product b',exact:true}).count(),1)
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  console.log('PASS: real detail routes isolate A/B data and ignore stale success and failure')

  await reset('detail')
  await page.getByRole('button',{name:'Змінити фото',exact:true}).click()
  await page.evaluate(()=>fixture.hold['commit-a']=true);await paste();await pending('commit-a')
  await page.getByRole('button',{name:'Закрити',exact:true}).click()
  assert.equal(await page.getByRole('dialog').count(),1)
  assert.equal(await page.getByRole('button',{name:'Готово',exact:true}).isDisabled(),true)
  assert.equal(await page.evaluate(()=>fixture.success.length),0)
  assert.deepEqual(await page.evaluate(()=>fixture.writes.map(({id,patch})=>({id,keys:Object.keys(patch)}))),[{id:'a',keys:['photo_url']}])
  await page.evaluate(()=>fixture.gates['commit-a'].reject(Error('disk full')))
  await ready()
  assert.equal(await page.getByRole('dialog').count(),1)
  assert.deepEqual(await page.evaluate(()=>fixture.errors),['disk full'])
  await page.evaluate(()=>fixture.hold['commit-a']=false);await paste()
  await page.waitForFunction(()=>fixture.success.length===1);await ready()
  await page.getByRole('button',{name:'Готово',exact:true}).click()
  await page.evaluate(()=>fixture.nav('/products/b'));await page.getByRole('heading',{name:'Product b',exact:true}).waitFor()
  await page.evaluate(()=>fixture.nav('/products/a'));await page.getByRole('heading',{name:'Product a',exact:true}).waitFor()
  assert.equal(await page.getByRole('img',{name:'Product a',exact:true}).getAttribute('src'),await page.evaluate(()=>fixture.products.a.photo_url))
  assert.equal(await page.evaluate(()=>fixture.products.a.qty_on_hand),2)
  console.log('PASS: real detail photo dialog waits for persistence, keeps old photo on error, survives reopening, never sends stock fields')

  await reset('form')
  await page.getByLabel('Назва товару *').fill('Changed product a')
  await page.evaluate(()=>{fixture.hold['clipboard-type']=true})
  await page.getByRole('button',{name:'Вставити з буфера'}).click();await pending('clipboard-type')
  await page.evaluate(()=>fixture.nav('/products/b/edit'))
  await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(i=>i.value==='Product b'))
  await settle('clipboard-type');await page.waitForTimeout(60)
  assert.equal(await page.evaluate(()=>fixture.uploads.length),0)
  assert.equal(await page.getByLabel('Назва товару *').inputValue(),'Product b')
  await page.evaluate(()=>fixture.nav('/products/new'))
  await page.getByRole('heading',{name:'Новий товар',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Назва товару *').inputValue(),'')
  assert.equal(await page.getByRole('img',{name:'Фото товару'}).count(),0)
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  console.log('PASS: real editor isolates drafts/photos when switching product or creating a new card')
  await reset('form')
  await page.getByLabel('Назва товару *').fill('Updated once')
  await page.evaluate(()=>{
    fixture.hold['commit-a']=true
    const form=document.querySelector('form')
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
  })
  await pending('commit-a')
  assert.equal(await page.evaluate(()=>fixture.writes.length),1,'Two submit events must create only one save')
  assert.equal(await page.getByLabel('Назва товару *').isDisabled(),true)
  assert.equal(await page.getByRole('button',{name:'Скасувати',exact:true}).isDisabled(),true)
  assert.equal(await page.evaluate(()=>Object.hasOwn(fixture.writes[0].patch,'qty_on_hand')),false)
  await settle('commit-a')
  await page.getByText('List',{exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(()=>fixture.success),['Товар оновлено'])
  console.log('PASS: synchronous double submit produces one save; controls locked; stock is not sent')

  const submit=()=>page.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  const editor=()=>page.getByRole('button',{name:'Зберегти зміни',exact:true})
  const code=()=>page.getByPlaceholder('4006633364515 або відскануйте...')
  const retail=()=>page.getByPlaceholder('450.00')
  const markup=()=>page.getByTitle('Розрахувати ціну: за таблицею націнки або швидкий відсоток від закупки')
  for(const fail of [false,true]){
    await reset('form');await page.evaluate(()=>fixture.hold['commit-a']=true)
    await submit();await pending('commit-a')
    await page.evaluate(()=>fixture.nav('/products/b/edit'))
    await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(i=>i.value==='Product b'))
    if(fail)await page.evaluate(()=>fixture.gates['commit-a'].reject(Error('Late save failure')))
    else await settle('commit-a')
    await page.waitForTimeout(40)
    assert.equal(await page.getByLabel('Назва товару *').inputValue(),'Product b')
    assert.equal(await editor().isDisabled(),false)
    assert.deepEqual(await page.evaluate(()=>fixture.errors.concat(fixture.success)),[])
  }
  console.log('PASS: stale save success/failure cannot close or disturb the next product editor')

  await reset('form');await page.evaluate(()=>fixture.hold['commit-a']=true)
  await retail().fill('1 250,50');await submit();await pending('commit-a')
  assert.equal(await page.evaluate(()=>fixture.writes[0].patch.retail_price),'1250.50')
  await page.evaluate(()=>fixture.gates['commit-a'].reject(Error('Не збережено')))
  await page.waitForFunction(()=>fixture.errors.length===1)
  assert.equal(await retail().inputValue(),'1 250,50');assert.equal(await editor().isDisabled(),false)
  await page.evaluate(()=>fixture.hold['commit-a']=false);await submit()
  await page.getByText('List',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.writes.length),2)
  console.log('PASS: a failed save preserves manual input; explicit retry uses exact normalized money')

  await reset('form');await page.evaluate(()=>fixture.nav('/products/new'))
  await page.getByRole('heading',{name:'Новий товар',exact:true}).waitFor()
  await page.getByLabel('Артикул (SKU) *').fill('NEW')
  await page.getByLabel('Назва товару *').fill('New product');await retail().fill('120,50')
  await page.evaluate(()=>{fixture.hold['commit-new']=true;const f=document.querySelector('form');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
  await pending('commit-new');assert.equal(await page.evaluate(()=>fixture.writes.length),1)
  assert.equal(await page.evaluate(()=>Object.hasOwn(fixture.writes[0].patch,'qty_on_hand')),false)
  await settle('commit-new');await page.getByText('List',{exact:true}).waitFor()
  console.log('PASS: a new product is created once; its card does not set stock')

  await reset('form');await page.evaluate(()=>fixture.hold.barcode=true)
  await page.getByRole('button',{name:'Генерувати',exact:true}).evaluate(b=>{b.click();b.click()});await pending('barcode')
  assert.equal(await page.evaluate(()=>fixture.barcodeCalls),1)
  await submit();assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  await code().fill('0012345678')
  await settle('barcode');await page.waitForTimeout(40)
  assert.equal(await code().inputValue(),'0012345678')
  assert.equal(await page.evaluate(()=>fixture.success.length),0)
  await page.getByRole('button',{name:'Генерувати',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('input[placeholder^="400663"]')?.value==='2000000000123')
  console.log('PASS: barcode generation is single-flight; manual barcode supersedes its late reply; next request works')

  await reset('form');await page.evaluate(()=>fixture.hold.price=true)
  await page.getByLabel('Закупівельна ціна (₴)').fill('1 000,50')
  await retail().fill('999,99')
  assert.equal(await page.getByText(/Увага: ціна закупівлі вища за роздрібну/).count(),1)
  await markup().selectOption('table');await pending('price')
  assert.equal(await page.evaluate(()=>fixture.priceCalls[0][0]),100050)
  await submit();assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  await retail().fill('1499,99');await settle('price');await page.waitForTimeout(40)
  assert.equal(await retail().inputValue(),'1499,99')
  assert.equal(await page.evaluate(()=>fixture.success.length),0)
  await markup().selectOption('pct:25')
  assert.equal(await retail().inputValue(),'1250.63')
  await page.evaluate(()=>fixture.suggestedPrice=NaN);await markup().selectOption('table')
  await page.waitForFunction(()=>fixture.errors.some(m=>m.includes('Розрахована ціна некоректна')))
  assert.equal(await retail().inputValue(),'1250.63')
  console.log('PASS: markup uses exact full price, respects later manual edits, rejects malformed results')

  for(const [kind,index] of [['category',0],['brand',1]]){
    await reset('form')
    const search=page.getByPlaceholder('Пошук або створити...').nth(index)
    await search.fill('Reference '+kind)
    await page.evaluate(kind=>fixture.hold['ref-'+kind]=true,kind)
    await page.getByRole('button',{name:new RegExp('Створити "Reference '+kind+'"')}).evaluate(b=>{b.click();b.click()})
    await pending('ref-'+kind);await submit()
    assert.equal(await page.evaluate(()=>fixture.refWrites.length),1)
    assert.equal(await page.evaluate(()=>fixture.writes.length),0)
    await settle('ref-'+kind);await page.waitForFunction(()=>fixture.success.length===1)
    await submit();await page.getByText('List',{exact:true}).waitFor()
    assert.equal(await page.evaluate(kind=>fixture.writes[0].patch[kind+'_id'],kind),kind==='category'?'cat-new':'brand-new')
  }
  console.log('PASS: category/brand creation is single-flight and serialized with product save')

  await reset('form')
  await page.getByPlaceholder('Пошук або створити...').first().fill('Uncertain category')
  await page.evaluate(()=>fixture.hold['ref-category']=true)
  await page.getByRole('button',{name:/Створити "Uncertain category"/}).click();await pending('ref-category')
  await page.evaluate(()=>fixture.gates['ref-category'].reject(Error('Unknown creation result')))
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByPlaceholder('Пошук або створити...').first().inputValue(),'Uncertain category')
  await submit();assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  await page.getByRole('button',{name:'Повторити завантаження'}).click()
  await page.waitForFunction(()=>!document.querySelector('fieldset').disabled)
  assert.equal(await page.evaluate(()=>fixture.refWrites.length),1)
  console.log('PASS: uncertain reference creation preserves input and requires read-only refresh, not a repeated write')

  await reset('form','&failRefs=1')
  await page.getByRole('alert').waitFor()
  await submit();assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  assert.equal(await page.getByLabel('Назва товару *').isDisabled(),true)
  await page.evaluate(()=>fixture.failRefs=false)
  await page.getByRole('button',{name:'Повторити завантаження'}).click()
  await page.waitForFunction(()=>!document.querySelector('fieldset').disabled)
  assert.equal(await page.getByLabel('Назва товару *').inputValue(),'Product a')
  assert.equal(await page.evaluate(()=>fixture.writes.length),0)
  console.log('PASS: failed references fail closed; read-only retry restores the form without writes')

  await reset('form','&role=cashier')
  assert.equal(await page.getByLabel('Закупівельна ціна (₴)').count(),0)
  assert.equal(await markup().isDisabled(),true)
  await submit();await page.getByText('List',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>Object.hasOwn(fixture.writes[0].patch,'purchase_price')),false)
  assert.equal(await page.evaluate(()=>Object.hasOwn(fixture.writes[0].patch,'qty_on_hand')),false)
  console.log('PASS: cashier save omits hidden purchase price and stock')
  await reset('detail')
  await page.getByRole('button',{name:'📌 Резерв'}).click()
  await page.getByLabel('Кількість резерву').fill('1abc')
  await page.getByRole('button',{name:'Зарезервувати',exact:true}).click()
  assert.equal(await page.evaluate(()=>fixture.detailWrites.length),0)
  await page.getByLabel('Кількість резерву').fill('1,125')
  await page.evaluate(()=>fixture.hold.reserve=true)
  await page.getByRole('button',{name:'Зарезервувати',exact:true}).evaluate(b=>{b.click();b.click()})
  await pending('reserve')
  assert.equal(await page.evaluate(()=>fixture.detailWrites.length),1)
  assert.deepEqual(await page.evaluate(()=>fixture.detailWrites[0].input),{product_id:'a',qty:1.125,customer_id:null,order_id:null,duration_days:3})
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1)
  assert.equal(await page.getByLabel('Кількість резерву').isDisabled(),true)
  await settle('reserve')
  await page.getByText('Зарезервовано: 1.125 шт',{exact:true}).waitFor()
  assert.equal(await page.getByRole('dialog').count(),0)
  console.log('PASS: exact reserve quantity, one synchronous write, no mid-save close, refreshed stock')

  await reset('detail')
  await page.getByRole('button',{name:'📌 Резерв'}).click()
  await page.evaluate(()=>fixture.hold.reserve=true)
  await page.getByRole('button',{name:'Зарезервувати',exact:true}).click();await pending('reserve')
  await page.evaluate(()=>fixture.nav('/products/b'))
  await page.getByRole('heading',{name:'Product b',exact:true}).waitFor()
  await page.evaluate(()=>fixture.gates.reserve.reject(Error('late reserve error')))
  await page.waitForTimeout(60)
  assert.deepEqual(await page.evaluate(()=>fixture.errors),[])
  console.log('PASS: a late reserve reply cannot change the next product card')

  await reset('detail')
  const crossInput=()=>page.getByPlaceholder('Наприклад:\n96182220\n94788122\nOC90')
  await crossInput().fill('OC195, PH6607')
  await page.evaluate(()=>fixture.hold['cross-add']=true)
  await page.getByRole('button',{name:'Додати номери'}).evaluate(b=>{b.click();b.click()})
  await pending('cross-add');assert.equal(await page.evaluate(()=>fixture.detailWrites.length),1)
  assert.equal(await crossInput().isDisabled(),true)
  await settle('cross-add')
  await page.getByRole('button',{name:'Product b',exact:true}).waitFor()
  assert.equal(await crossInput().inputValue(),'')
  assert.equal(await page.getByTitle('Видалити номер').count(),2)
  page.once('dialog',dialog=>dialog.accept())
  await page.getByTitle('Видалити номер').first().click()
  await page.waitForFunction(()=>fixture.crosses.a.length===1)
  assert.equal(await page.getByTitle('Видалити номер').count(),1)
  console.log('PASS: local cross-number add/remove updates analogs without duplicate submissions')

  await reset('detail')
  await page.evaluate(()=>fixture.failLinks=true)
  await crossInput().fill('OC195')
  await page.getByRole('button',{name:'Додати номери'}).click()
  await page.getByRole('alert').waitFor()
  assert.deepEqual(await page.evaluate(()=>fixture.success),['Крос-номери збережено'])
  assert.equal(await page.getByText('За внесеними крос-номерами пов’язаних товарів не знайдено.',{exact:true}).count(),0)
  assert.equal(await crossInput().isDisabled(),true)
  await page.evaluate(()=>fixture.failLinks=false)
  await page.getByRole('button',{name:'Оновити аналоги'}).click()
  await page.getByRole('button',{name:'Product b',exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.detailWrites.length),1)
  console.log('PASS: successful cross save plus failed reload shows a read-only retry, not another save')

  await reset('detail')
  await crossInput().fill('OC195')
  await page.evaluate(()=>fixture.hold['cross-add']=true)
  await page.getByRole('button',{name:'Додати номери'}).click();await pending('cross-add')
  await page.evaluate(()=>fixture.gates['cross-add'].reject(Error('Cross write failed')))
  await page.waitForFunction(()=>fixture.errors.length===1)
  assert.equal(await crossInput().inputValue(),'OC195')
  assert.equal(await page.evaluate(()=>fixture.success.length),0)
  console.log('PASS: failed cross save retains typed numbers and does not claim success')

  await reset('detail')
  await page.getByRole('button',{name:'Видалити',exact:true}).click()
  await page.evaluate(()=>fixture.hold.delete=true)
  await page.getByRole('dialog').getByRole('button',{name:'Видалити',exact:true}).evaluate(b=>{b.click();b.click()})
  await pending('delete')
  assert.equal(await page.evaluate(()=>fixture.detailWrites.length),1)
  await page.evaluate(()=>fixture.gates.delete.reject(Error('Delete blocked')))
  await page.waitForFunction(()=>fixture.errors.length===1)
  assert.equal(await page.getByRole('dialog').count(),1)
  assert.equal(await page.getByRole('heading',{name:'Product a',exact:true}).count(),1)
  await page.evaluate(()=>fixture.hold.delete=false)
  await page.getByRole('dialog').getByRole('button',{name:'Видалити',exact:true}).click()
  await page.getByText('List',{exact:true}).waitFor()
  console.log('PASS: delete failure keeps confirmation open; explicit retry navigates only on success')

  await reset('detail')
  await page.evaluate(()=>fixture.hold['detail-barcode']=true)
  await page.getByRole('button',{name:'Згенерувати штрихкод'}).evaluate(b=>{b.click();b.click()})
  await pending('detail-barcode');assert.equal(await page.evaluate(()=>fixture.detailWrites.length),1)
  await page.evaluate(()=>fixture.nav('/products/b'));await page.getByRole('heading',{name:'Product b',exact:true}).waitFor()
  await settle('detail-barcode');await page.waitForTimeout(60)
  assert.equal(await page.getByText('2000000000123',{exact:true}).count(),0)
  assert.deepEqual(await page.evaluate(()=>fixture.success),[])
  console.log('PASS: barcode generation is serialized and cannot replace another card')

  await reset('detail','&web=1')
  for(const name of ['📌 Резерв','Редагувати','Видалити','Згенерувати штрихкод','Змінити фото','Додати номери']){
    assert.equal(await page.getByRole('button',{name,exact:true}).count(),0)
  }
  assert.equal(await page.evaluate(()=>fixture.detailWrites.length),0)
  await reset('detail','&role=cashier')
  assert.equal(await page.getByRole('button',{name:'📌 Резерв',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Редагувати',exact:true}).count(),1)
  assert.equal(await page.getByRole('button',{name:'Видалити',exact:true}).count(),0)
  await reset('detail','&offline=1')
  await crossInput().fill('OC195')
  await page.getByRole('button',{name:'Додати номери'}).click()
  await page.getByRole('button',{name:'Product b',exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.detailWrites.length),1)
  console.log('PASS: web detail is read-only; cashier permissions respected; cross editing works offline')
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
}finally{await browser?.close();await server.close()}
