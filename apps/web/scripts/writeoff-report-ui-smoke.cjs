// Synthetic UI fixtures only: no shop data, external requests or printers.
const path=require('node:path'),assert=require('node:assert/strict'),{mkdirSync}=require('node:fs')
process.chdir(path.resolve(__dirname,'../../..'));mkdirSync('tmp',{recursive:true})
const {chromium}=require('playwright'),XLSX=require('../node_modules/xlsx')
;(async()=>{
 const {createServer}=await import('../node_modules/vite/dist/node/index.js')
 const html='<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:writeoff-fixture"></script></body></html>'
 const fixture=String.raw`
 import React from 'react'
 import {createRoot} from 'react-dom/client'
 import {MemoryRouter} from 'react-router-dom'
 import '/src/index.css'
 const {useAuthStore}=await import('/src/stores/authStore.ts')
 useAuthStore.getState().setOfflineSession({access_token:'fixture',refresh_token:'fixture',user:{id:'fixture-owner',app_metadata:{role:'owner',tenant_id:'fixture'}}})
 const {api}=await import('/src/lib/api.ts');api.get=async()=>({data:[],pagination:{total_pages:1}})
 const {reportApi}=await import('/src/features/reports/reportApi.ts')
 const {parseWriteoffSummary}=await import('/src/features/reports/writeoffReportData.ts')
 const {businessDateKey,businessDateRangeUtc}=await import('/src/lib/businessDate.ts')
 window.mode='many';window.pending=null;window.calls=0
 reportApi.salesPeriod=async()=>({data:{total_sales:0,total_revenue:0,returns_count:0,returns_total:0,net_revenue:0,payment_received_total:0,profit:0,sales:[],daily:[],by_method:{cash:0,card:0,transfer:0,account:0,debt:0}}})
 reportApi.soldItems=async()=>({data:[]})
 reportApi.writeoffsSummary=async()=>{
  window.calls++
  if(window.mode==='failure')throw Error('Тест: неповний акт списання')
  const month=businessDateKey().slice(0,7),count=window.mode==='empty'?0:25
  const data=parseWriteoffSummary({month,count,total_cost:count*123456,
   writeoffs:Array.from({length:count},(_,i)=>({id:'w'+i,reason:'loss',total_cost:123456,
    created_at:businessDateRangeUtc(month+'-01',month+'-01').from,
    items:[{id:'l'+i,cost_kopecks:123456}]}))},month)
  if(window.mode==='hold')await new Promise(resolve=>window.pending=resolve)
  return {data}
 }
 const {default:DailyReport}=await import('/src/features/reports/DailyReport.tsx')
 createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/reports']},React.createElement(DailyReport)))
 `
 const server=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),
  server:{host:'127.0.0.1',port:5188,strictPort:true},plugins:[{
   name:'writeoff-fixture',resolveId:id=>id==='virtual:writeoff-fixture'?'\0virtual:writeoff-fixture':null,
   load:id=>id==='\0virtual:writeoff-fixture'?fixture:null,
   configureServer(dev){dev.middlewares.use((req,res,next)=>{
    if(req.url!=='/__writeoff_fixture')return next()
    res.setHeader('Content-Type','text/html');dev.transformIndexHtml('/__writeoff_fixture',html).then(result=>res.end(result))
   })}
  }]})
 await server.listen()
 let browser
 try{
  browser=await chromium.launch({channel:'chrome',headless:true})
  const page=await browser.newPage({viewport:{width:1200,height:850},acceptDownloads:true})
  const errors=[],downloads=[];page.on('pageerror',e=>errors.push(e.message));page.on('download',file=>downloads.push(file))
  await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:5188/')?route.continue():route.fulfill({status:503,body:'External network disabled'}))
  await page.goto('http://127.0.0.1:5188/__writeoff_fixture')
  const choose=async tab=>{
   if(page.viewportSize().width<768)await page.locator('select').first().selectOption(tab)
   else await page.getByRole('button',{name:tab==='writeoffs'?'Списання':'Сьогодні',exact:true}).click()
  }
  await choose('writeoffs');await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===25)
  for(const width of [1200,390,320]){
   await page.setViewportSize({width,height:850})
   if(width<768)await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().right<=1)
   await page.locator('tbody tr').last().scrollIntoViewIfNeeded()
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const sizes=await page.evaluate(()=>({body:document.body.scrollWidth-innerWidth,
    main:document.getElementById('app-main-scroll').scrollWidth-document.getElementById('app-main-scroll').clientWidth}))
   assert.ok(sizes.body<=1&&sizes.main<=1,JSON.stringify(sizes))
   const box=await page.locator('tbody tr').last().boundingBox();assert.ok(box.y>=0&&box.y+box.height<=850,'final act unreachable')
   await page.screenshot({path:'tmp/stage24-writeoffs-bottom-'+width+'.png'})
   await page.locator('#app-main-scroll').evaluate(el=>el.scrollTop=0)
   await page.screenshot({path:'tmp/stage24-writeoffs-top-'+width+'.png'})
  }
  const pendingDownload=page.waitForEvent('download')
  await page.getByRole('button',{name:'Експорт в Excel',exact:true}).click()
  await(await pendingDownload).saveAs('tmp/stage24-writeoff-fixture.xlsx')
  const book=XLSX.readFile('tmp/stage24-writeoff-fixture.xlsx')
  assert.deepEqual(book.SheetNames,['Звіт','Підсумок'])
  const rows=XLSX.utils.sheet_to_json(book.Sheets['Звіт']),summary=XLSX.utils.sheet_to_json(book.Sheets['Підсумок'])
  assert.equal(rows.length,25);assert.equal(rows[0]['Собівартість (грн)'],1234.56)
  assert.equal(summary.find(row=>row.Показник==='Собівартість (грн)').Значення,30864)
  assert.match(JSON.stringify(summary),/Серверна копія/)
  assert.match(rows[0]['Дата'],/^01\./)
  await choose('today');await page.evaluate(()=>window.mode='failure');await choose('writeoffs')
  await page.getByRole('alert').filter({hasText:'Тест: неповний акт списання'}).waitFor()
  assert.equal(await page.getByText('Собівартість списань',{exact:true}).count(),0)
  assert.equal(await page.locator('tbody tr').count(),0)
  await page.getByRole('button',{name:'Експорт в Excel',exact:true}).click()
  assert.equal(downloads.length,1,'stale report exported')
  await page.screenshot({path:'tmp/stage24-writeoffs-error-320.png'})
  await choose('today');await page.evaluate(()=>window.mode='hold');await choose('writeoffs')
  await page.waitForFunction(()=>typeof window.pending==='function')
  assert.equal(await page.getByText('Собівартість списань',{exact:true}).count(),0,'stale total while loading')
  await choose('today');await page.evaluate(()=>{window.pending();window.pending=null})
  await page.getByText('Прийнято оплат до повернень',{exact:true}).waitFor()
  assert.equal(await page.getByText('Собівартість списань',{exact:true}).count(),0,'late reply crossed tabs')
  await page.evaluate(()=>window.mode='empty');await choose('writeoffs')
  await page.getByText('Списань цього місяця немає',{exact:true}).waitFor()
  assert.equal(errors.length,0,errors.join('\n'))
  console.log(JSON.stringify({passed:true,checks:['1200/390/320: all acts reachable, no horizontal overflow','25 acts exported with exact total and source',
   'Kyiv dates in export','failure clears old totals and blocks stale export','loading clears old totals','late reply ignored','true empty state'],liveDataModified:false}))
 }finally{if(browser)await browser.close();await server.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
