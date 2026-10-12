// Run only through apps/web/scripts/native-navigation-close-ui-smoke.mjs.
// Hidden temporary Electron profile, actual window/app lifecycle, no shop DB.
const { app, BrowserWindow, session } = require('electron')
console.log('Native close fixture bootstrap')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
const assert = require('node:assert/strict')
const path = require('node:path')
const [base, root, controllerPath] = process.argv.slice(process.argv[2] === '--' ? 3 : 2)
assert(new URL(base).hostname === '127.0.0.1')
const { NativeCloseController, requestUnloadScript, deferQuitForMainWindow } = require(controllerPath)
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
const results = [], external = [], failures = []
let current = null, cleanup = 0, finished = false
const deadline = setTimeout(() => { console.error('Native close deadline'); app.exit(2) }, 80000)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, label) {
  const end = Date.now() + 10000
  while (!(await test())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await wait(25) }
}
async function evaluate(win, code) { return win.webContents.executeJavaScript(code) }
async function open() {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const controller = new NativeCloseController({
    isDestroyed: () => win.isDestroyed(), requestApproval: deadline => evaluate(win, requestUnloadScript(deadline)),
    close: () => win.close(), failed: error => failures.push(String(error)),
  })
  win.on('close', event => controller.onClose(event))
  win.on('closed', () => controller.stop())
  await win.loadURL(base + 'native-close#/edit')
  await until(() => evaluate(win, "Boolean(document.querySelector('#busy') && fixture.setValue)"), 'renderer ready')
  // Wait for passive React effects, including the native approval listener.
  await until(() => evaluate(win, "(()=>{const detail={handled:false,approved:false,deadline:Date.now()+30000};window.dispatchEvent(new CustomEvent('forsage:request-unload',{detail}));return detail.handled})()"), 'guard listener')
  return win
}
async function dirty(win, value = 'unsaved') {
  await evaluate(win, `fixture.setValue(${JSON.stringify(value)})`)
  await until(() => evaluate(win, `document.querySelector('#value')?.textContent===${JSON.stringify(value)}`), 'dirty render')
}
async function busy(win, value) {
  await evaluate(win, `fixture.setBusy(${value})`)
  await until(() => evaluate(win, `document.querySelector('#busy')?.textContent===${JSON.stringify(String(value))}`), 'busy render')
}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const allowed = url.origin === new URL(base).origin || url.protocol === 'ws:' && url.hostname === '127.0.0.1'
    if (!allowed) external.push(details.url)
    callback({ cancel: !allowed })
  })
  let win = await open()
  win.close(); await until(() => win.isDestroyed(), 'clean native close')
  results.push('clean native close')

  win = await open(); await dirty(win)
  win.close(); win.close()
  await until(() => evaluate(win, 'fixture.confirms===1'), 'one dirty prompt')
  await wait(100)
  assert(!win.isDestroyed()); assert.equal(await evaluate(win, "document.querySelector('#value').textContent"), 'unsaved')
  assert.equal(await evaluate(win, 'fixture.confirms'), 1)
  await evaluate(win, 'fixture.accept=true'); win.close()
  await until(() => win.isDestroyed(), 'accepted native close')
  results.push('dirty cancel retains draft; duplicate close single prompt; accepted close')

  win = await open(); await busy(win, true)
  win.close(); await until(() => evaluate(win, 'fixture.alerts===1'), 'busy close denied')
  assert(!win.isDestroyed()); assert.equal(await evaluate(win, 'fixture.confirms'), 0)
  await busy(win, false); win.close(); await until(() => win.isDestroyed(), 'finished save close')
  results.push('busy denies close without discard; completed save closes')

  current = await open(); await dirty(current)
  app.on('before-quit', event => {
    if (finished) return
    if (deferQuitForMainWindow(event, current)) return
    event.preventDefault(); cleanup++
    assert.equal(cleanup, 1); assert.equal(current, null)
    assert.deepEqual(external, []); assert.deepEqual(failures, [])
    results.push('app.quit canceled before cleanup; one cleanup after actual close')
    console.log('NATIVE_CLOSE_PASS ' + JSON.stringify({ results, cleanup, externalRequests: external.length }))
    // Production cleanup awaits commands/backups before its final app.quit.
    // Do not recursively quit inside the same canceled before-quit callback.
    finished = true; clearTimeout(deadline); setImmediate(() => app.quit())
  })
  current.on('closed', () => { current = null; app.quit() })
  app.quit()
  await until(() => evaluate(current, 'fixture.confirms===1'), 'app.quit dirty prompt')
  await wait(100)
  assert.equal(cleanup, 0); assert(current && !current.isDestroyed())
  assert.equal(await evaluate(current, "document.querySelector('#value').textContent"), 'unsaved')
  await busy(current, true); app.quit()
  await until(() => evaluate(current, 'fixture.alerts===1'), 'app.quit busy denied')
  assert.equal(cleanup, 0)
  await busy(current, false); await evaluate(current, 'fixture.accept=true'); app.quit()
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1) })
