// Actual assistant and parsing worker, synthetic invoices only. Never opens the shop DB.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const XLSX = require('xlsx')
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const mocks = {
  '@/lib/desktopBridge': 'export const desktopBridge=()=>fixture.bridge;export const isDesktopRuntime=()=>true',
  '@/lib/api': 'export const api={get:async()=>{throw Error("Unexpected server request")},post:async()=>({data:{vin:fixture.vin||null}})}',
  '@/stores/authStore': 'const state={session:{user:{id:"test-user",app_metadata:{role:"cashier",tenant_id:"fixture"}}}};export const useAuthStore=Object.assign(s=>s(state),{getState:()=>state})',
  '@/features/admin/adminApi': 'export const adminApi={listCategories:async()=>({data:[]})}',
  '@/features/products/productApi': 'export const requestDesktopSync=()=>{}',
  '@/features/ai/aiApi': `export const aiApi={status:async()=>{if(fixture.authRequired)throw Object.assign(Error('Session required'),{status:401});if(!fixture.online)throw Error('Offline');return {data:{enabled:true,has_key:true,model:'test',usage:{cost_usd:0,requests:0}}}},chat:async body=>{fixture.aiCalls.push(body);if(body.history?.length>40)throw Error('Невірні дані');return {data:fixture.aiResponse}},recognizeSupplyInvoice:async body=>{fixture.photoCalls.push(body);if(fixture.authRequired)throw Object.assign(Error('Session required'),{status:401});return {data:fixture.aiResponse}}}`,
  '@/lib/desktopServerConnection': 'export async function reconnectDesktopServer(password){fixture.connectCalls=(fixture.connectCalls||0)+1;await new Promise(resolve=>setTimeout(resolve,100));if(password!=="fixture-pass")throw Error("Невірний пароль");fixture.authRequired=false;fixture.online=true}',
  '@/features/ai/OrderConfirmModal': 'export const OrderConfirmModal=({action,onConfirm,applying})=><button disabled={applying} onClick={()=>onConfirm({...action.payload,comment:"Перевірено касиром"})}>Fixture confirm order</button>',
  '@/lib/processingUploads': 'export const dataUrlToBlob=()=>({type:"image/jpeg"});export const uploadProcessingBlob=async()=>({path:"test-user/ai/photo.jpg",mimeType:"image/jpeg"});export const removeProcessingUploads=async()=>{}',
  '@/components/Layout': 'export function Layout({children,title}){return <main><h1>{title}</h1>{children}</main>}',
  '@/components/ui/Toast': 'export const toast={error:m=>fixture.errors.push(m),warning:m=>fixture.warnings.push(m),success:m=>fixture.messages.push(m)};export const ToastContainer=()=>null',
}
mocks['@/features/ai/aiApi'] += `;aiApi.applyAction=async body=>{(fixture.orderCalls??=[]).push(body);fixture.orderCheckpoint=JSON.parse(localStorage.getItem('forsage:ai-chat:v2:fixture:test-user:assistant'));const prior=localStorage.getItem('fixture:order-write');if(prior&&prior!==JSON.stringify(body))throw Error('Changed retry');localStorage.setItem('fixture:order-write',JSON.stringify(body));if(fixture.loseOrderReply)throw Error('Lost order reply');return {data:{result:{id:'one-order',order_number:1,status:'lead'}}}}`
mocks['@/features/ai/aiApi'] += `;const normalPhoto=aiApi.recognizeSupplyInvoice;aiApi.recognizeSupplyInvoice=async body=>{if(fixture.photoFailure)throw Error(fixture.photoFailure);const result=await normalPhoto(body);if(fixture.deferPhoto)await new Promise(resolve=>{fixture.releasePhoto=resolve});return result}`
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,useLocation} from 'react-router-dom';
import AiAssistantPage from '/src/features/ai/AiAssistantPage.tsx';
function App(){const location=useLocation();const [visible,setVisible]=React.useState(true);fixture.hideAssistant=()=>setVisible(false);return <><p data-testid="location">{location.pathname+location.search}</p>{visible&&<AiAssistantPage/>}</>}
createRoot(document.getElementById('root')).render(<MemoryRouter><App/></MemoryRouter>);`
const bootstrap = `window.fixture={online:false,errors:[],warnings:[],messages:[],invoices:[],aiCalls:[],photoCalls:[],aiResponse:{reply:'Товари розібрано',usage:{cost_usd:0},actions:[{id:'ai-test',tool:'create_products_bulk',title:'Товари',changes:[],payload:{products:[{name:'Фільтр',sku:'',qty_on_hand:2,purchase_price_uah:120}]}}]}};
fixture.bridge={supply:{previewInvoiceFromAi:async body=>body.rows.map(row=>({name:row.name,source_name:row.name,brand:row.brand||'',product_id:null,status:'new',reason:'Новий товар',candidates:[]})),createInvoiceFromAi:async body=>{fixture.invoices.push(body);await new Promise(r=>setTimeout(r,100));return {invoice:{id:'invoice-fixture',supplier_id:null,invoice_number:'',edit_revision:'ai-base-revision'},draft_items:body.rows,unresolved:[],matched:1,created:0}}}};`
const server = await createServer({cacheDir:createSmokeCache(), configFile:false,root:path.join(root,'apps/web'),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'apps/web/src')}},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'ai-input-fixture',enforce:'pre',resolveId(id){if(id==='virtual:ai-input.tsx'||Object.hasOwn(mocks,id))return '\0'+id},
  async load(id){
    if(id==='\0virtual:ai-input.tsx')return transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})
    let source=id.startsWith('\0')?mocks[id.slice(1)]:undefined
    for(const [name,mock] of Object.entries(mocks))if(id.replaceAll('\\','/').replace(/\.tsx?$/,'').endsWith('/src/'+name.slice(2)))source=mock
    if(source)return transformWithEsbuild(source,'mock.tsx',{loader:'tsx',jsx:'automatic'})
  },configureServer(server){server.middlewares.use('/ai-input-test',async(_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/ai-input-test','<html><body><div id="root"></div><script>'+bootstrap+'</script><script type="module" src="/@id/__x00__virtual:ai-input.tsx"></script></body></html>'))})},
}]})
const table = 'Назва\tАртикул\tШтрихкод\tКількість\tЦіна\nКруг 100мм\t001\t2000177521924\t98\t10,00'
const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(table.split('\n').map(r=>r.split('\t'))),'Товари')
const xlsx = { name:'Накладна.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'}) }
let browser
try {
  await server.listen();browser=await chromium.launch({headless:true})
  const page=await browser.newPage(),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message))
  const base=server.resolvedUrls.local[0]
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort())
  const reset=async()=>{await page.goto(base+'ai-input-test');await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByRole('button',{name:'Excel / файл',exact:true}).waitFor()}
  const paste=async text=>page.locator('textarea').evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))},text)
  const review=async()=>{await page.getByRole('button',{name:'Перевірити таблицю',exact:true}).click();await page.getByRole('button',{name:/Підтвердити та зберегти/}).waitFor();await page.getByText('Зіставляю з локальною базою…',{exact:true}).waitFor({state:'hidden'})}
  await reset()
  await page.locator('input[type=file]').setInputFiles(xlsx)
  await review()
  assert.equal(await page.getByText(/Кількість: 98 · Закупка/).count(),1)
  await page.getByRole('button',{name:/Підтвердити та зберегти/}).evaluate(button=>{button.click();button.click()})
  await page.waitForFunction(()=>document.querySelector('[data-testid=location]').textContent.includes('/suppliers/invoices/new?resume='))
  const first=await page.evaluate(()=>({invoices:fixture.invoices,aiCalls:fixture.aiCalls,draft:JSON.parse(localStorage.getItem('forsage:supply-invoice:edit-invoice-fixture:draft:v2'))}))
  assert.equal(first.invoices.length,1);assert.equal(first.aiCalls.length,0);assert.equal(first.invoices[0].rows[0].qty,98)
  assert.equal(first.draft.payFullNow,false);assert.equal(first.draft.paymentMethod,'cash');assert.equal(first.draft.serverInvoiceId,'invoice-fixture');assert.equal(first.draft.baseRevision,'ai-base-revision')
  await reset();await paste(table);await review()
  assert.equal(await page.getByText(/Кількість: 98 · Закупка/).count(),1)
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  await reset()
  await page.evaluate(text=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>text}}),table)
  await page.getByRole('button',{name:'Вставити',exact:true}).click();await review()
  assert.equal((await page.evaluate(()=>fixture.aiCalls)).length,0)
  // Owner's numbered clipboard text works offline, without asking Gemini to invent a table.
  await reset();await paste(readFileSync(new URL('./fixtures/clipboard-supply-blocks.txt',import.meta.url),'utf8'));await review()
  assert.equal(await page.getByRole('note').filter({hasText:'орієнтовна'}).count(),1)
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  for(const price of [141,162,165,186]) assert.equal(await page.getByText(new RegExp('Кількість: 1 · Закупка: '+price+' грн')).count(),1)
  await page.getByRole('button',{name:/Підтвердити та зберегти/}).evaluate(button=>{button.click();button.click()})
  await page.waitForFunction(()=>fixture.invoices.length===1)
  const blockResult=await page.evaluate(()=>({invoice:fixture.invoices[0],ai:fixture.aiCalls.length,photo:fixture.photoCalls.length}))
  assert.equal(blockResult.ai,0);assert.equal(blockResult.photo,0)
  assert.equal(blockResult.invoice.rows.length,4)
  assert.deepEqual(blockResult.invoice.rows.map(row=>row.purchase_price_uah),[141,162,165,186])
  assert.equal(blockResult.invoice.rows.reduce((sum,row)=>sum+row.qty*row.purchase_price_uah,0),654)
  assert.equal(new Set(blockResult.invoice.rows.map(row=>row.name)).size,4)
  assert.match(blockResult.invoice.notes,/орієнтовна/)
  assert.ok(blockResult.invoice.rows.every(row=>!row.sku && !row.barcode && !('retail_price_uah' in row)))
  await reset();await paste(table.replace('\t98\t','\tпомилка\t'))
  await page.waitForFunction(()=>fixture.errors.length>0)
  assert.match((await page.evaluate(()=>fixture.errors))[0],/кількість/)
  assert.equal(await page.getByRole('button',{name:'Перевірити таблицю',exact:true}).count(),0)
  await reset();await page.locator('input[type=file]').setInputFiles([xlsx,{...xlsx,name:'Друга.xlsx'}])
  await page.waitForFunction(()=>fixture.errors.length>0)
  assert.match((await page.evaluate(()=>fixture.errors))[0],/одну таблицю/)
  await reset();await page.evaluate(()=>{fixture.online=true});await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await paste('Два фільтри\nЗакупівельна ціна за штуку 120 грн')
  await page.waitForFunction(()=>fixture.messages.length>0)
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByRole('button',{name:/Підтвердити та зберегти/}).waitFor()
  const request=await page.evaluate(()=>fixture.aiCalls[0])
  assert.match(request.file_text,/Два фільтри/);assert.equal(request.history,undefined)
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  await page.getByText(/Кількість: 2 · Закупка: 120 грн/).waitFor()
  await reset();await paste('Назва\tАртикул\tКількість\tЦіна\nКабель\t001\t2\t1,19\nВсього на суму 2,38 USD.')
  await page.getByRole('textbox',{name:'Курс USD',exact:true}).waitFor()
  await page.getByRole('button',{name:'Перевірити таблицю',exact:true}).click()
  await page.waitForFunction(()=>fixture.errors.some(error=>error.includes('курс')))
  assert.equal(await page.getByRole('button',{name:/Підтвердити та зберегти/}).count(),0)
  await page.getByRole('textbox',{name:'Курс USD',exact:true}).fill('42,50')
  await review()
  assert.equal(await page.getByText(/Закупка: 50.58 грн/).count(),1)
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  // Catalog ambiguity is resolved inside this same confirmation window.
  await reset()
  await page.evaluate(()=>{fixture.bridge.supply.previewInvoiceFromAi=async body=>body.rows.map(row=>({name:'Олива E-TEC 10W40 4л',source_name:row.name,brand:'E-TEC',product_id:null,status:'review',reason:'Є схожі товари',candidates:[{id:'known-oil',name:'Наша олива E-TEC 4л',sku:'44397',barcode:'2009703825277',brand:'E-TEC'}]}))})
  await paste(table);await review()
  assert.equal(await page.getByRole('button',{name:/Підтвердити та зберегти/}).isDisabled(),true)
  await page.getByLabel('Товар для рядка 1',{exact:true}).selectOption('known-oil')
  await page.getByText('З бази: Наша олива E-TEC 4л',{exact:true}).waitFor()
  await page.getByRole('button',{name:/Підтвердити та зберегти/}).click()
  await page.waitForFunction(()=>fixture.invoices.length===1)
  assert.equal((await page.evaluate(()=>fixture.invoices[0].rows[0])).match_choice,'known-oil')
  assert.equal((await page.evaluate(()=>fixture.invoices[0].rows[0])).qty,98)
  assert.equal((await page.evaluate(()=>fixture.aiCalls)).length,0)
  await reset()
  await page.evaluate(()=>{fixture.bridge.supply.previewInvoiceFromAi=async()=>{throw Error('Catalog unavailable')}})
  await paste(table);await review()
  await page.getByRole('alert').filter({hasText:'Catalog unavailable'}).waitFor()
  assert.equal(await page.getByRole('button',{name:/Підтвердити та зберегти/}).isDisabled(),true)
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  await reset();await paste(table);await review()
  await page.getByLabel('Назва нового товару 1',{exact:true}).fill('Круг TEST 100мм')
  await page.getByLabel('Бренд нового товару 1',{exact:true}).fill('TEST')
  await page.getByRole('button',{name:/Підтвердити та зберегти/}).click()
  await page.waitForFunction(()=>fixture.invoices.length===1)
  assert.equal((await page.evaluate(()=>fixture.invoices[0].rows[0])).name,'Круг TEST 100мм')
  assert.equal((await page.evaluate(()=>fixture.invoices[0].rows[0])).brand,'TEST')
  // Default photo upload, WITHOUT toggling the mode, must use the invoice endpoint.
  const photoFixture=process.env.FORSAGE_AI_PHOTO_FIXTURE || {name:'invoice.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=','base64')}
  await reset()
  await page.evaluate(()=>localStorage.setItem('forsage:ai-chat:v2:fixture:test-user:assistant',JSON.stringify({entries:Array.from({length:56},(_,i)=>({role:i%2?'model':'user',text:'Previous '+i})),applied:{'previous-invoice':'ok'}})))
  await page.reload();await page.evaluate(()=>{fixture.online=true;fixture.aiResponse.reply='Натисніть Застосувати';fixture.aiResponse.actions[0].payload={supplier_name:'Постачальник тест',products:[
    {name:'Автошина 155/70/13 Doublestar WINTERKING DW08 75T',brand_name:'Doublestar',sku:'',qty:4,purchase_price_uah:1455},
    {name:'Гайка M12x1,25x16 мм',sku:'',qty:20,purchase_price_uah:14},
    {name:'Гайка M12x1,5x25 мм',sku:'',qty:20,purchase_price_uah:18},
    {name:'Автошина 205/55/16 Doublestar WINTERKING DW02 91T',brand_name:'Doublestar',sku:'',qty:4,purchase_price_uah:1860},
    {name:'Автошина 185/65/14 Rydanz NORDICA NR01 86H',brand_name:'Rydanz',sku:'',qty:2,purchase_price_uah:1782},
    {name:'Автошина 195/65/15 Premiorri ViaMaggiore Z Plus 91H',brand_name:'Premiorri',sku:'',qty:1,purchase_price_uah:1750},
  ]}})
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.locator('input[type=file]').setInputFiles(photoFixture)
  await page.waitForFunction(()=>fixture.messages.some(message=>message.includes('прикріплено')))
  // The owner's screenshot is a photo sent without any typed request.
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByRole('button',{name:/Підтвердити та зберегти \(6\)/}).waitFor()
  await page.getByText('Зіставляю з локальною базою…',{exact:true}).waitFor({state:'hidden'})
  const photoRequest=await page.evaluate(()=>fixture.photoCalls[0])
  assert.equal((await page.evaluate(()=>fixture.aiCalls)).length,0)
  assert.equal(photoRequest.history,undefined);assert.equal(photoRequest.images.length,1)
  assert.match(photoRequest.message,/НЕ артикули/);assert.match(photoRequest.message,/НЕ роздрібна/)
  const preserved=await page.evaluate(()=>JSON.parse(localStorage.getItem('forsage:ai-chat:v2:fixture:test-user:assistant')))
  assert.equal(preserved.entries.length,58);assert.equal(preserved.applied['previous-invoice'],'ok')
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  await page.getByRole('button',{name:/Підтвердити та зберегти \(6\)/}).evaluate(button=>{button.click();button.click()})
  await page.waitForFunction(()=>fixture.invoices.length===1)
  const received=await page.evaluate(()=>fixture.invoices[0])
  assert.equal(received.supplier_name,'Постачальник тест')
  assert.equal(received.rows.length,6)
  assert.equal(received.rows.reduce((sum,row)=>sum+Math.round(row.qty*row.purchase_price_uah*100),0),1921400)
  assert.ok(received.rows.every(row=>!row.sku && !('retail_price_uah' in row)))
  assert.equal(received.rows[0].brand,'Doublestar')
  // A malformed/retail-only response or an empty response cannot become a partial draft.
  for (const empty of [false,true]) {
    await reset();await page.evaluate(empty=>{fixture.online=true;if(empty)fixture.aiResponse.actions=[];else fixture.aiResponse.actions[0].payload.products=[{name:'Автошина',sku:'1',qty_on_hand:4,retail_price_uah:1455}]},empty)
    await page.getByRole('button',{name:'Повторити',exact:true}).click()
    await page.locator('input[type=file]').setInputFiles(photoFixture)
    await page.waitForFunction(()=>fixture.messages.some(message=>message.includes('прикріплено')))
    await page.locator('textarea').fill('Накладна шини')
    await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
    await page.getByText(empty?/ШІ повернув відповідь без таблиці приходу/:/перевірте закупівельну ціну/).waitFor()
    assert.equal(await page.locator('textarea').inputValue(),'Накладна шини')
    assert.equal(await page.getByRole('button',{name:/Видалити фото/}).count(),1)
    assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  }
  await reset();await page.evaluate(()=>{fixture.online=true;fixture.aiResponse.actions=[]})
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await paste('Два фільтри\nЗакупівельна ціна за штуку 120 грн')
  await page.waitForFunction(()=>fixture.messages.length>0)
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByText(/Текст залишився прикріпленим/).waitFor()
  assert.equal(await page.getByText(/Фото залишилося/).count(),0)
  assert.equal((await page.evaluate(()=>fixture.invoices)).length,0)
  // A valid table plus a second malformed action must never silently become a partial invoice.
  await reset();await page.evaluate(()=>{fixture.online=true;fixture.aiResponse.actions.push({id:'bad',tool:'create_products_bulk',payload:{products:[]}})})
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await paste('Два фільтри\nЗакупівельна ціна за штуку 120 грн')
  await page.waitForFunction(()=>fixture.messages.length>0)
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByText(/одна з таблиць товарів порожня або пошкоджена/).waitFor()
  assert.equal(await page.getByRole('button',{name:/Підтвердити та зберегти/}).count(),0)
  assert.equal(await page.evaluate(()=>fixture.invoices.length),0)
  // Retry uses the retained attachment and only then allows the complete draft.
  await page.evaluate(()=>{fixture.aiResponse.actions.pop()})
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByRole('button',{name:/Підтвердити та зберегти/}).waitFor()
  assert.equal(await page.evaluate(()=>fixture.aiCalls.length),2)
  assert.equal(await page.evaluate(()=>fixture.aiCalls[1].file_text),await page.evaluate(()=>fixture.aiCalls[0].file_text))
  assert.equal(await page.evaluate(()=>fixture.invoices.length),0)
  // The parent confirmation flow checkpoints edited fields and replays the same operation after reload.
  await reset()
  await page.evaluate(()=>localStorage.setItem('forsage:ai-chat:v2:fixture:test-user:assistant',JSON.stringify({entries:[{role:'model',text:'Замовлення для тесту',actions:[{id:'stable-order',tool:'create_order',title:'Замовлення',changes:[],payload:{vin:'WVWZZZ1JZXW000001',items:[]}}]}]})))
  await page.reload()
  await page.evaluate(()=>{fixture.loseOrderReply=true})
  await page.getByRole('button',{name:'Перевірити та створити замовлення',exact:true}).click()
  await page.getByRole('button',{name:'Fixture confirm order',exact:true}).evaluate(button=>{button.click();button.click()})
  await page.waitForFunction(()=>fixture.errors.includes('Lost order reply'))
  const originalOrder=await page.evaluate(()=>({calls:fixture.orderCalls,checkpoint:fixture.orderCheckpoint}))
  assert.equal(originalOrder.calls.length,1)
  assert.match(originalOrder.calls[0].operation_id,/^[a-f0-9]{64}$/)
  assert.equal(originalOrder.checkpoint.entries[0].actions[0].payload.comment,'Перевірено касиром')
  await page.reload()
  await page.getByRole('button',{name:'Перевірити та створити замовлення',exact:true}).click()
  await page.getByRole('button',{name:'Fixture confirm order',exact:true}).click()
  await page.waitForFunction(()=>fixture.messages.some(message=>message.includes('Замовлення #1 створено')))
  assert.deepEqual(await page.evaluate(()=>fixture.orderCalls[0]),originalOrder.calls[0])
  // Decode a transparent clipboard PNG in the real browser; JPEG background must stay white.
  assert.equal(await page.evaluate(async()=>{
    const {fileToCompressedImage}=await import('/src/features/ai/aiImageInput.ts')
    const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20
    const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.fillRect(15,5,10,10)
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))
    const result=await fileToCompressedImage(new File([blob],'transparent.png',{type:'image/png'}))
    const img=new Image();img.src=result.dataUrl;await img.decode()
    ctx.drawImage(img,0,0);const pixel=ctx.getImageData(0,0,1,1).data
    return pixel[0]>245&&pixel[1]>245&&pixel[2]>245&&pixel[3]===255
  }),true)
  // Network/timeout failures preserve the photo and text, and never create an invoice.
  for (const failure of ['Network unavailable fixture','Request timeout fixture']) {
    await reset();await page.evaluate(failure=>{fixture.online=true;fixture.photoFailure=failure},failure)
    await page.getByRole('button',{name:'Повторити',exact:true}).click()
    await page.locator('input[type=file]').setInputFiles(photoFixture)
    await page.getByRole('button',{name:/Видалити фото/}).waitFor()
    await page.locator('textarea').fill('Накладна — повтор після збою')
    await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
    await page.getByText(new RegExp(failure)).waitFor()
    assert.equal(await page.getByRole('button',{name:/Видалити фото/}).count(),1)
    assert.equal(await page.locator('textarea').inputValue(),'Накладна — повтор після збою')
    assert.equal(await page.evaluate(()=>fixture.invoices.length),0)
    await page.evaluate(()=>{fixture.photoFailure=null})
    await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
    await page.getByRole('button',{name:/Підтвердити та зберегти/}).waitFor()
    assert.equal(await page.evaluate(()=>fixture.invoices.length),0)
  }
  // A late response cannot reopen the assistant after leaving the page.
  await reset();await page.evaluate(()=>{fixture.online=true;fixture.deferPhoto=true})
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.locator('input[type=file]').setInputFiles(photoFixture)
  await page.getByRole('button',{name:/Видалити фото/}).waitFor()
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.waitForFunction(()=>typeof fixture.releasePhoto==='function')
  await page.evaluate(()=>fixture.hideAssistant())
  await page.locator('textarea').waitFor({state:'hidden'})
  await page.evaluate(()=>fixture.releasePhoto())
  await page.waitForTimeout(100)
  assert.equal(await page.getByRole('button',{name:/Підтвердити та зберегти/}).count(),0)
  assert.equal(await page.evaluate(()=>fixture.invoices.length),0)
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('forsage:ai-chat:v2:fixture:test-user:assistant')).entries.filter(e=>e.role==='model').length),0)
  // Explicit order photos retain the bounded chat path; VIN remains separate.
  await reset();await page.evaluate(()=>{fixture.online=true;fixture.aiResponse.actions=[];fixture.aiResponse.reply='Перевірте замовлення';localStorage.setItem('forsage:ai-chat:v2:fixture:test-user:assistant',JSON.stringify({entries:Array.from({length:56},(_,i)=>({role:i%2?'model':'user',text:'Previous '+i}))}))})
  await page.reload();await page.evaluate(()=>{fixture.online=true;fixture.aiResponse.actions=[];fixture.aiResponse.reply='Перевірте замовлення'})
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.locator('input[type=file]').setInputFiles(photoFixture)
  await page.waitForFunction(()=>fixture.messages.some(message=>message.includes('прикріплено')))
  await page.locator('textarea').fill('Створи замовлення з зошита')
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByText('Перевірте замовлення',{exact:true}).waitFor()
  assert.equal((await page.evaluate(()=>fixture.photoCalls)).length,0)
  assert.equal((await page.evaluate(()=>fixture.aiCalls[0])).history.length,40)
  await reset();await page.evaluate(()=>{fixture.vin='WVWZZZ1JZXW000001'})
  await page.locator('input[type=file]').setInputFiles(photoFixture)
  await page.getByText('VIN розпізнано',{exact:true}).waitFor()
  assert.equal((await page.evaluate(()=>fixture.photoCalls)).length,0)
  // PIN-only session: reconnect without losing attached photo or message.
  await reset();await page.evaluate(()=>{fixture.authRequired=true})
  await page.getByRole('button',{name:'Повторити',exact:true}).click()
  await page.getByLabel('Пароль вашого акаунта').waitFor()
  await page.locator('input[type=file]').setInputFiles(photoFixture)
  await page.getByRole('button',{name:/Видалити фото/}).waitFor()
  await page.locator('textarea').fill('Накладна після PIN')
  await page.getByLabel('Пароль вашого акаунта').fill('wrong-fixture')
  await page.getByRole('button',{name:'Підключити ШІ',exact:true}).click()
  await page.getByText('Невірний пароль',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('Пароль вашого акаунта').inputValue(),'')
  assert.equal(await page.locator('textarea').inputValue(),'Накладна після PIN')
  assert.equal(await page.getByRole('button',{name:/Видалити фото/}).count(),1)
  await page.getByLabel('Пароль вашого акаунта').fill('fixture-pass')
  await page.getByRole('button',{name:'Підключити ШІ',exact:true}).evaluate(button=>{button.click();button.click()})
  await page.getByLabel('Пароль вашого акаунта').waitFor({state:'hidden'})
  assert.equal(await page.evaluate(()=>fixture.connectCalls),2)
  assert.equal(await page.locator('textarea').inputValue(),'Накладна після PIN')
  assert.equal(await page.getByRole('button',{name:/Видалити фото/}).count(),1)
  assert.equal(await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).isEnabled(),true)
  // Expired session during recognition also exposes reconnect and keeps the photo.
  await page.evaluate(()=>{fixture.authRequired=true})
  await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
  await page.getByLabel('Пароль вашого акаунта').waitFor()
  assert.equal(await page.locator('textarea').inputValue(),'Накладна після PIN')
  assert.equal(await page.getByRole('button',{name:/Видалити фото/}).count(),1)
  assert.equal(await page.evaluate(()=>fixture.invoices.length),0)
  // Network restored: status recovers without reloading or clearing input.
  await reset();await page.locator('textarea').fill('Збережене завдання')
  await page.evaluate(()=>{fixture.online=true;window.dispatchEvent(new Event('online'))})
  await page.getByRole('button',{name:'Повторити',exact:true}).waitFor({state:'hidden'})
  assert.equal(await page.locator('textarea').inputValue(),'Збережене завдання')
  assert.equal(await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).isEnabled(),true)
  if(process.env.FORSAGE_AI_INVOICE_FIXTURE){
    await reset();await page.locator('input[type=file]').setInputFiles(process.env.FORSAGE_AI_INVOICE_FIXTURE)
    await page.getByRole('textbox',{name:'Курс USD',exact:true}).fill('42,50')
    await review()
    await page.getByRole('button',{name:/Підтвердити та зберегти \(31\)/}).click()
    await page.waitForFunction(()=>fixture.invoices.length===1)
    const rows=await page.evaluate(()=>fixture.invoices[0].rows)
    assert.equal(rows.length,31)
    assert.ok(rows.some(row=>row.purchase_price_uah===50.58))
    assert.ok(rows.every(row=>row.sku.startsWith('000')))
    assert.equal((await page.evaluate(()=>fixture.aiCalls)).length,0)
  }
  assert.deepEqual(pageErrors,[])
  console.log('PASS: Excel/clipboard plus 4 owner description blocks / 654 UAH offline with approximate price warning; single confirmed draft, currencies, catalog review; dedicated photo invoice API, 6 rows / 19214 UAH; invalid results preserve photo or text; order/VIN and reconnect preserved'+(process.env.FORSAGE_AI_INVOICE_FIXTURE?', owner TDSheet 31 rows preserved':''))
} finally {await browser?.close();await server.close()}
