// Isolated Chromium exercise. Never opens the shop database or a physical printer.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const dist = path.resolve(__dirname, process.argv.includes('--staged') ? '../release/staged/win-unpacked/resources/app.asar/dist' : process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { loadPrintHtml } = require(path.join(dist, 'print/loadPrintHtml.js'))
const { getPrintSession } = require(path.join(dist, 'print/printSession.js'))
const { renderReceiptRaster } = require(path.join(dist, 'print/receiptRaster.js'))
const { printLabelsTspl } = require(path.join(dist, 'print/tsplLabelPrinter.js'))
const { RendererRecovery } = require(path.join(dist, 'rendererRecovery.js'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-print-render-'))
app.setPath('userData', path.join(root, 'profile'))
if (process.argv.includes('--software')) app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.on('child-process-gone', (_event, details) => console.log('child-process-gone', details.type, details.reason, details.exitCode))
const deadline = setTimeout(() => { console.error('Print smoke timed out'); app.exit(1) }, 60000)
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }))
  for (const offscreen of [false, true]) {
    const window = new BrowserWindow({ show: false, width: 400, height: 600, webPreferences: { session: getPrintSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen, backgroundThrottling: false } })
    window.webContents.on('did-fail-load', (_e, code, description, _url, main) => console.log('did-fail-load', code, description, main))
    window.webContents.on('render-process-gone', (_e, d) => console.log('render-process-gone', d.reason, d.exitCode))
    try {
      for (const count of [1, 1000, 1]) {
        const body = '<section class="label-page"><b>Фільтр 1457434310 — 120 грн</b><svg width="100" height="30"><path d="M0 0h90v30H0z"/></svg></section>'.repeat(count)
        const html = '<!doctype html><html lang="uk"><head><meta charset="utf-8"></head><body>' + body + (count > 1 ? '<!--' + 'я'.repeat(2100000) + '-->' : '') + '<script>window.untrustedPrintScript=true</script></body></html>'
        await loadPrintHtml(window, html)
        assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".label-page").length'), count)
        assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
        assert.equal(await window.webContents.executeJavaScript('window.untrustedPrintScript'), undefined, 'page scripts must not run')
        const pdf = await window.webContents.printToPDF({ pageSize: 'A4' })
        assert(pdf.length > 1000)
        console.log('Rendered', { offscreen, count, pdfBytes: pdf.length })
      }
    } finally { window.destroy() }
  }
  const raster = await renderReceiptRaster('<!doctype html><meta charset="utf-8"><style>body{font:16px Arial}</style><div class="receipt-print">Форсаж<br>ТЕСТ ДРУКУ<br>120 грн</div>', { widthDots: 384, dpiX: 203, dpiY: 203 })
  assert(raster.length > 100)
  console.log('Receipt raster OK', raster.length)
  const label = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}.label-page{width:40mm;height:25mm;background:white;color:black;font:14px Arial}</style><div class="label-page">ТЕСТ 120 грн<br><svg width="100" height="30"><path d="M0 0h90v30H0z"/></svg></div>'
  process.env.FORSAGE_TSPL_DRY_RUN = path.join(root, 'labels.tspl')
  const labels = await printLabelsTspl(label, { printerName: 'POS-80', widthMm: 40, heightMm: 25 })
  assert.equal(labels.labels, 1)
  assert(labels.bytes > 8000)
  const data = fs.readFileSync(process.env.FORSAGE_TSPL_DRY_RUN)
  const offset = data.indexOf(Buffer.from('BITMAP 0,0,40,200,0,')) + Buffer.byteLength('BITMAP 0,0,40,200,0,')
  assert(data.subarray(offset, offset + 8000).filter(value => value !== 255).length > 100, 'TSPL must contain actual ink')
  console.log('Label TSPL dry run OK', labels.bytes)
  const window = new BrowserWindow({ show: false, webPreferences: { session: getPrintSession(), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  let loads = 0, recovered
  const complete = new Promise((resolve, reject) => { recovered = { resolve, reject } })
  const recovery = new RendererRecovery({ isDestroyed: () => window.isDestroyed(), delays: [300, 500], retry: () => {}, load: async () => { await loadPrintHtml(window, '<h1 id="ok">Recovered UI</h1>'); if (++loads > 1) recovered.resolve() } })
  window.webContents.on('render-process-gone', () => { void recovery.crashed().catch(recovered.reject) })
  await recovery.start()
  window.webContents.forcefullyCrashRenderer()
  await complete
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#ok").textContent'), 'Recovered UI')
  recovery.stop(); window.destroy()
  console.log('Native renderer crash recovery OK; main process survived')
  clearTimeout(deadline)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
app.on('quit', () => {
  // Only the exact directory generated by this test can be removed.
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-print-render-')) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows may retain a Chromium cache handle until exit. */ }
  }
})
