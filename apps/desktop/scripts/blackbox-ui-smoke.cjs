const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { BlackBox } = require('../dist/diagnostics/blackBox.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-blackbox-ui-'))
app.setPath('userData', path.join(root, 'profile'))
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }))
  const box = new BlackBox(path.join(root, 'logs'))
  const received = []
  ipcMain.on('desktop:diagnostic-event', (_event, data) => {
    received.push(data.kind)
    if (data.kind === 'renderer-error') box.record('renderer-error', new Error(data.message))
  })
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, '../dist/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  await window.loadURL('data:text/html,<html><body><script>window.addEventListener("error",e=>window.forsageDesktop.diagnostics.reportError("renderer-error",e.message,e.error.stack));setTimeout(()=>{throw new Error("DO-NOT-LOG-SECRET")},30)</script></body></html>')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert(received.includes('section'))
  assert(received.includes('renderer-error'), 'isolated bridge must deliver real main-world errors')
  window.destroy()
  await box.close()
  const logs = fs.readdirSync(path.join(root, 'logs')).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(path.join(root, 'logs', f), 'utf8')).join('')
  assert(logs.includes('renderer-error'))
  assert(!logs.includes('DO-NOT-LOG-SECRET'))
  console.log('Black box UI smoke passed: sandboxed preload observes UI errors; secrets excluded')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
