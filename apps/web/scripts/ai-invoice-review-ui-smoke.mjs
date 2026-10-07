import assert from 'node:assert/strict'
import path from 'node:path'
import { startFixture, root } from './ai-invoice-ui-fixture.mjs'
const test=await startFixture(),{page,reset,paste,openTable,getDraft,errors}=test
try{
await reset()
await page.evaluate(()=>{
fixture.mode='mixed';fixture.catalog=[
{id:'known',name:'Наш резонатор Тернопіль',sku:'OUR44',barcode:'2000000000044',unit:'шт',brand:null,retail_price:90000},
{id:'one',name:'Амортизатор Hort HA30308',sku:'H1',barcode:'2000000000001',unit:'шт',brand:null,retail_price:100000},
{id:'two',name:'Амортизатор EuroEx',sku:'E2',barcode:'2000000000002',unit:'шт',brand:null,retail_price:110000}]
})
const rows=Array.from({length:30},(_,i)=>[i===0?'Резонатор':i===1?'Спірний амортизатор':'Новий товар '+(i+1),i===0?'44':i===2?'ARCHIVED':'NEW-'+i,'',i===0?2:1, i===0?605:100])
await paste('Назва\tАртикул\tШтрихкод\tКількість\tЦіна\n'+rows.map(row=>row.join('\t')).join('\n'));await openTable()
assert.equal(await page.getByRole('dialog').count(),0,'No matching modal')
await page.waitForFunction(()=>document.querySelectorAll('[data-ai-issue]').length===4)
assert.equal(await page.getByRole('button',{name:'Провести',exact:true}).isDisabled(),true)
assert.equal((await getDraft()).items[0].product_id,'known')
assert.equal((await getDraft()).items[0].purchase_price,60500)
assert.equal(await page.locator('[data-ai-issue]:visible').count(),2)
await page.locator('[data-ai-issue]:visible select').selectOption('one')
const third=page.locator('tbody tr').nth(2)
await third.getByPlaceholder('Артикул',{exact:true}).fill('CORRECTED')
await page.waitForFunction(()=>!document.querySelector('button[type=submit]').disabled)
assert.equal(await page.locator('[data-ai-issue]:visible').count(),0)
// A barcode scan of another existing product keeps quantity/purchase and replaces identity.
const fourth=page.locator('tbody tr').nth(3)
const bar=fourth.locator('td').nth(4).locator('input')
await bar.fill('2000000000002');await bar.press('Tab')
await page.waitForFunction(()=>fixture.previewCalls.some(rows=>rows[3]?.match_choice==='two'))
const qty=page.locator('input[data-invoice-quantity]:visible').first()
await qty.fill('7');await page.waitForFunction(()=>fixture.previewCalls.some(rows=>rows[0].qty===7))
await qty.fill('8');await page.waitForFunction(()=>!document.querySelector('button[type=submit]').disabled)
await new Promise(r=>setTimeout(r,800));assert.equal(await qty.inputValue(),'8')
await page.getByRole('combobox',{name:'Постачальник',exact:true}).click()
await page.getByRole('option',{name:/Постачальник тест/}).click()
for(const viewport of [{width:1366,height:900},{width:390,height:844}]){
await page.setViewportSize(viewport)
await page.locator('input[data-invoice-quantity]:visible').last().scrollIntoViewIfNeeded()
const box=await page.locator('input[data-invoice-quantity]:visible').last().boundingBox()
assert.ok(box&&box.y>=0&&box.y<viewport.height,'Last row reachable')
await page.getByRole('button',{name:'Провести',exact:true}).scrollIntoViewIfNeeded()
await page.screenshot({path:path.join(root,'.ux-shots','ai-invoice-inline-'+viewport.width+'.png')})
}
await page.setViewportSize({width:1366,height:900})
await page.getByRole('button',{name:'Провести',exact:true}).evaluate(button=>{button.click();button.click()})
await page.waitForFunction(()=>fixture.writes.length===1)
const posted=await page.evaluate(()=>fixture.writes[0])
assert.equal(posted.items.length,30);assert.equal(posted.items[0].qty,8);assert.equal(posted.items[1].product_id,'one');assert.equal(posted.items[3].product_id,'two')
assert.equal(posted.items[3].purchase_price,10000);assert.equal(posted.items[3].qty,1)
assert.deepEqual(errors,[])
console.log('AI_INLINE_INVOICE_OK: ordinary 30-row form, no modal, automatic existing card, red disputes, corrected SKU, barcode replacement, latest quantity, desktop/mobile last row, single post')
} catch(error){console.error(await page.locator('body').innerText(),await page.evaluate(()=>fixture.errors));throw error}
finally{await test.close()}
