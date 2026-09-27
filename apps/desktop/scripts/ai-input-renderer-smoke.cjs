// Real Electron file:// renderer + production worker, no application backend / shop database.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const XLSX = require('xlsx')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-ai-input-ui-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../web/dist')
const timer = setTimeout(() => { console.error('Renderer test timeout'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show:false, webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true} })
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel:/^https?:/i.test(details.url)}))
  await window.loadFile(path.join(dist,'index.html'))
  const workerName = fs.readdirSync(path.join(dist,'assets')).find(name=>/^aiSupplyImport\.worker-.*\.js$/.test(name))
  assert.ok(workerName, 'Production parsing worker missing')
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Назва','Артикул','Кількість','Ціна'],['Круг','001',98,10]]),'Товари')
  const bytes = Array.from(process.env.FORSAGE_AI_INVOICE_FIXTURE ? fs.readFileSync(process.env.FORSAGE_AI_INVOICE_FIXTURE) : XLSX.write(book,{type:'buffer',bookType:'xlsx'}))
  const url = pathToFileURL(path.join(dist,'assets',workerName)).href
  const result = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const worker=new Worker(${JSON.stringify(url)},{type:'module'});
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Worker timeout'))},5000);
    worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(Error('File worker load failed'))};
    worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};
    const buffer=new Uint8Array(${JSON.stringify(bytes)}).buffer;worker.postMessage({buffer,excel:true},[buffer]);
  })`)
  assert.equal(result.error,undefined)
  if(process.env.FORSAGE_AI_INVOICE_FIXTURE){
    assert.equal(result.result.products.length,31)
    assert.equal(result.result.sourceCurrency,'USD')
    assert.equal(result.result.products.reduce((sum,p)=>sum+Math.round(p.purchase_price_uah*100)*p.qty,0),37432)
  } else assert.deepEqual(result.result.products,[{name:'Круг',sku:'001',qty:98,purchase_price_uah:10}])
  const clipboard = fs.readFileSync(path.resolve(__dirname,'../../web/scripts/fixtures/clipboard-supply-blocks.txt'),'utf8')
  const parsedText = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const worker=new Worker(${JSON.stringify(url)},{type:'module'});
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Clipboard worker timeout'))},5000);
    worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(Error('Clipboard worker failed'))};
    worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};
    worker.postMessage({text:${JSON.stringify(clipboard)}});
  })`)
  assert.equal(parsedText.error,undefined)
  assert.equal(parsedText.result.products.length,4)
  assert.deepEqual(parsedText.result.products.map(row=>row.purchase_price_uah),[141,162,165,186])
  assert.match(parsedText.result.products[3].purchase_price_note,/орієнтовна/)
  assert.ok(parsedText.result.products.every(row=>row.qty===1 && !row.sku && !row.barcode))
  console.log('PASS: compiled Excel and owner clipboard parsing worker under Electron file://; 4 rows / 654 UAH, approximate price warning; sandbox enabled, no network or shop DB')
  window.destroy()
  clearTimeout(timer)
  app.exit(0)
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1)})
process.on('exit',()=>{
  if(path.dirname(temporary)===os.tmpdir()&&path.basename(temporary).startsWith('forsage-ai-input-ui-')){
    try{fs.rmSync(temporary,{recursive:true,force:true})}catch{/* Chromium may still hold isolated cache files. */}
  }
})
