import assert from 'node:assert/strict'
import { startFixture, require } from './ai-invoice-ui-fixture.mjs'
const XLSX=require('xlsx')
const test=await startFixture(),{page,reset,paste,openTable,getDraft,errors}=test
const table='Назва\tАртикул\tШтрихкод\tКількість\tЦіна\nКруг 100мм\t001\t2000177521924\t98\t10,00'
const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(table.split('\n').map(row=>row.split('\t'))),'Товари')
const file={name:'Накладна.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})}
try{
for(const method of ['file','paste','clipboard']){
await reset()
if(method==='file')await page.locator('input[type=file]').setInputFiles(file)
else if(method==='paste')await paste(table)
else{await page.evaluate(text=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>text}}),table);await page.getByRole('button',{name:'Вставити',exact:true}).click()}
await openTable()
assert.equal(await page.getByRole('dialog').count(),0)
assert.equal(await page.locator('input[data-invoice-quantity]:visible').inputValue(),'98')
const draft=await getDraft()
assert.equal(draft.items[0].purchase_price,1000);assert.equal(draft.payFullNow,false);assert.equal(draft.paymentMethod,'cash')
assert.equal(await page.evaluate(()=>fixture.writes.length+fixture.aiCalls.length),0,'Opening a draft is read-only/offline')
}
await page.locator('input[data-invoice-quantity]:visible').fill('99')
await page.waitForFunction(()=>!document.querySelector('button[type=submit]').disabled)
await page.evaluate(()=>{sessionStorage.setItem('start-route',fixture.location);window.dispatchEvent(new Event('pagehide'))})
await page.reload();await page.locator('input[data-invoice-quantity]:visible').waitFor()
assert.equal(await page.locator('input[data-invoice-quantity]:visible').inputValue(),'99')
await reset();await page.evaluate(()=>fixture.failPreview=true);await paste(table)
await page.getByRole('button',{name:'Перевірити таблицю',exact:true}).click()
await page.waitForFunction(()=>fixture.errors.includes('Preview unavailable'))
assert.equal(await page.locator('[data-supply-invoice-form]').count(),0)
await page.evaluate(()=>fixture.failPreview=false)
await page.getByRole('button',{name:/Відкрити накладну/}).click()
await page.locator('[data-supply-invoice-form]').waitFor()
await reset();await paste([141,162,165,186].map((price,i)=>(i+1)+'️⃣ Хрестовий балонний ключ '+(i<2?'18':'20')+'″ — '+(i%2?'посилений':'стандартний')+'\nКількість: 1 шт.\nЗакупівля: '+(i===3?'приблизно ':'')+price+' грн/шт.\nЦіна продажу: '+(550+i*50)+' грн/шт.').join('\n\n'))
await openTable()
const blocks=await getDraft();assert.equal(blocks.items.length,4);assert.equal(blocks.items.reduce((sum,item)=>sum+item.total,0),65400)
assert.ok(blocks.items[3].ai_review.source.purchase_price_note)
await reset();await page.evaluate(()=>{fixture.online=true;fixture.response.actions[0].payload.invoice_total=241})
await page.getByRole('button',{name:'Повторити',exact:true}).click()
const photo={name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/D1EAAAAASUVORK5CYII=','base64')}
await page.locator('input[type=file]').setInputFiles(photo)
await page.waitForFunction(()=>fixture.messages.some(message=>message.includes('прикріплено')))
await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
await page.getByText(/Загальний підсумок накладної не збігається/).waitFor()
assert.equal(await page.locator('[data-supply-invoice-form]').count(),0)
assert.equal(await page.getByRole('button',{name:/Видалити фото/}).count(),1)
await page.evaluate(()=>fixture.response.actions[0].payload.invoice_total=240)
await page.getByRole('button',{name:'Надіслати повідомлення',exact:true}).click()
await page.locator('[data-supply-invoice-form]').waitFor()
assert.equal((await getDraft()).items[0].total,24000)
assert.equal(await page.evaluate(()=>fixture.aiCalls.length),0)
assert.equal(await page.evaluate(()=>fixture.writes.length),0)
assert.deepEqual(errors,[])
console.log('AI_INPUT_ORDINARY_DRAFT_OK: Excel, paste, clipboard offline; 98 units; no matching modal/no writes; reload keeps 99; retry; four text blocks 654 UAH; photo wrong total retains attachment and correct retry opens one draft')
}catch(error){console.error(await page.locator('body').innerText(),await page.evaluate(()=>fixture.errors));throw error}
finally{await test.close()}
