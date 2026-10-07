// Isolated report UI: fixture data only, no live database, external network or printer.
const path = require('node:path')
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
process.chdir(path.resolve(__dirname, '../../..'))
mkdirSync('tmp', { recursive:true })
const { chromium } = require('playwright')
const XLSX = require('../node_modules/xlsx')
;(async () => {
  const { createServer } = await import('../node_modules/vite/dist/node/index.js')
  const html = '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:period-fixture"></script></body></html>'
  const fixture = String.raw`
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import '/src/index.css'
const { useAuthStore } = await import('/src/stores/authStore.ts')
useAuthStore.getState().setOfflineSession({ access_token:'fixture',refresh_token:'fixture',user:{id:'fixture-owner',app_metadata:{role:'owner',tenant_id:'fixture'}} })
const { api } = await import('/src/lib/api.ts')
api.get=async()=>({data:[],pagination:{total_pages:1}})
const { reportApi } = await import('/src/features/reports/reportApi.ts')
const { parsePeriodReport } = await import('/src/features/reports/periodReportData.ts')
window.requests=[];window.mode='many';window.pending=null
const sample=(date,onlyRefund=false)=>{
  const count=onlyRefund?0:25,total=count*123456
  return {total_sales:count,total_revenue:total,returns_count:1,returns_total:10000,net_revenue:total-10000,
    profit:total-10000,payment_received_total:total,by_method:{cash:total,card:0,transfer:0,account:0,debt:0},
    sales:Array.from({length:count},(_,i)=>({id:'fixture-'+i,sale_number:'FIXTURE-'+(i+1),total:123456,
      payment_method:'mixed',status:'completed',completed_at:date+'T10:00:00Z',customer:null})),
    daily:[{date,sales:count,gross_revenue:total,returns_total:10000,revenue:total-10000}]}
}
reportApi.salesPeriod=async(from,to)=>{
  window.requests.push([from,to,window.mode])
  if(window.mode==='failure')throw Error('Тест: звіт не завантажено')
  const data=parsePeriodReport(sample(from,window.mode==='refund'),from,to)
  if(window.mode==='hold')await new Promise(resolve=>window.pending=resolve)
  return {data}
}
reportApi.soldItems=async()=>({data:[]})
const { default: DailyReport } = await import('/src/features/reports/DailyReport.tsx')
createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/reports']},React.createElement(DailyReport)))
`
  const server=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),
    server:{host:'127.0.0.1',port:5187,strictPort:true},plugins:[{
      name:'period-report-fixture',
      resolveId(id){if(id==='virtual:period-fixture')return '\0virtual:period-fixture'},
      load(id){if(id==='\0virtual:period-fixture')return fixture},
      configureServer(dev){dev.middlewares.use((req,res,next)=>{
        if(req.url!=='/__period_fixture')return next()
        res.setHeader('Content-Type','text/html')
        dev.transformIndexHtml('/__period_fixture',html).then(result=>res.end(result))
      })}
    }]})
  await server.listen()
  let browser
  try {
    browser=await chromium.launch({channel:'chrome',headless:true})
    const page=await browser.newPage({viewport:{width:1200,height:850},acceptDownloads:true})
    const errors=[],downloads=[]
    page.on('pageerror',e=>errors.push(e.message))
    page.on('download',file=>downloads.push(file))
    await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:5187/')
      ?route.continue():route.fulfill({status:503,body:'External network disabled in test'}))
    await page.goto('http://127.0.0.1:5187/__period_fixture')
    await page.getByText('Прийнято оплат до повернень',{exact:true}).waitFor()
    assert.match(await page.getByTestId('report-source').innerText(),/серверна копія.*може відставати/)
    const choose=async tab=>{
      if(page.viewportSize().width<768)await page.locator('select').first().selectOption(tab)
      else await page.getByRole('button',{name:tab==='period'?'За період':tab==='weekly'?'7 днів':'Сьогодні',exact:true}).click()
    }
    const setDates=async from=>{
      await page.getByLabel('Від',{exact:true}).fill(from)
      await page.getByLabel('До',{exact:true}).fill(from)
    }
    await choose('period');await setDates('2026-10-03')
    await page.getByRole('button',{name:'Показати',exact:true}).click()
    const last=page.getByText('#FIXTURE-25',{exact:true})
    await last.waitFor()
    assert.equal(await page.getByText('Змішана',{exact:true}).count(),25)
    for(const width of [1200,390,320]){
      await page.setViewportSize({width,height:850})
      if(width<768)await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().right<=1)
      await last.scrollIntoViewIfNeeded()
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      const overflow=await page.evaluate(()=>{
        const main=document.getElementById('app-main-scroll')
        return {main:main.scrollWidth-main.clientWidth,body:document.body.scrollWidth-window.innerWidth,
          bottom:main.scrollHeight-main.clientHeight-main.scrollTop}
      })
      assert.ok(overflow.main<=1 && overflow.body<=1,'horizontal overflow '+width+' '+JSON.stringify(overflow))
      const bounds=await last.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=850,'last receipt not reachable')
      await page.screenshot({path:'tmp/stage19-period-bottom-'+width+'.png',animations:'disabled'})
      await page.locator('#app-main-scroll').evaluate(el=>el.scrollTop=0)
      await page.screenshot({path:'tmp/stage19-period-top-'+width+'.png'})
    }
    const exported=page.waitForEvent('download')
    await page.getByRole('button',{name:'Експорт в Excel',exact:true}).click()
    const download=await exported
    await download.saveAs('tmp/stage19-period-fixture.xlsx')
    let book=XLSX.readFile('tmp/stage19-period-fixture.xlsx')
    assert.deepEqual(book.SheetNames,['Звіт','Підсумок'])
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Звіт']).length,25)
    assert.match(JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets['Підсумок'])),/30764/)
    await page.evaluate(()=>window.mode='refund');await setDates('2026-10-04')
    assert.equal(await last.count(),0,'old rows remain under changed dates')
    await page.getByRole('button',{name:'Показати',exact:true}).click()
    await page.getByText('Продажів немає',{exact:true}).waitFor()
    const refundExport=page.waitForEvent('download')
    await page.getByRole('button',{name:'Експорт в Excel',exact:true}).click()
    await (await refundExport).saveAs('tmp/stage19-refund-fixture.xlsx')
    book=XLSX.readFile('tmp/stage19-refund-fixture.xlsx')
    const summary=JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets['Підсумок']))
    assert.match(summary,/-100/);assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Звіт']).length,0)
    await page.evaluate(()=>window.mode='failure')
    await page.getByRole('button',{name:'Показати',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Тест: звіт не завантажено'}).waitFor()
    assert.equal(await page.getByText('Після повернень',{exact:true}).count(),0)
    await page.getByRole('button',{name:'Експорт в Excel',exact:true}).click()
    assert.equal(downloads.length,2,'failed report exported stale file')
    await page.evaluate(()=>window.mode='hold')
    await page.getByRole('button',{name:'Показати',exact:true}).click()
    await page.waitForFunction(()=>typeof window.pending==='function')
    await setDates('2026-10-02')
    await page.evaluate(()=>{window.pending();window.pending=null})
    await page.getByRole('button',{name:'Показати',exact:true}).waitFor()
    assert.equal(await last.count(),0,'delayed response overwrote new dates')
    await page.evaluate(()=>window.mode='failure');await choose('weekly')
    await page.getByRole('alert').filter({hasText:'Тест: звіт не завантажено'}).waitFor()
    assert.equal(await page.locator('main').getByText('0,00 ₴',{exact:true}).count(),0,'network error shown as zero')
    await page.screenshot({path:'tmp/stage19-weekly-error-320.png'})
    await page.evaluate(()=>window.mode='many');await choose('today');await choose('weekly')
    await page.getByText('Сума по днях після повернень',{exact:true}).waitFor()
    await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===7)
    assert.equal(errors.length,0,errors.join('\n'))
    console.log(JSON.stringify({passed:true,checks:['1200/390/320: no horizontal overflow and final receipt reachable',
      'mixed payment visible','server copy warning','period export: 25 receipts and gross/returns/net summary',
      'return-only export without receipts','changed dates discard prior rows','delayed response rejected',
      'loading/error not reported as zero','weekly: seven days from one response'],liveDataModified:false}))
  } finally {if(browser)await browser.close();await server.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
