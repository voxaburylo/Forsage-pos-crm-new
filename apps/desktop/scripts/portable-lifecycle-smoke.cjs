// Builds an isolated portable fixture with the real launcher configuration.
// No shop main/preload, database, account, network or physical printer is used.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const { build, Platform, Arch } = require('electron-builder')
const builderRequire = createRequire(require.resolve('electron-builder'))
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = libraryRequire('@electron/asar')
const project = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-portable-probe-'))
const oldWrapper = process.argv.includes('--reproduce-old-wrapper')
const children = []
let failed = false
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 45000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out: ' + label)
    await delay(100)
  }
}
function launch(exe) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env })
  const state = { child, done: false }
  child.once('exit', code => { state.done = true; state.code = code })
  child.once('error', error => { state.done = true; state.error = error })
  children.push(state)
  return state
}
async function main() {
  assert.equal(process.platform, 'win32')
  const appSource = path.join(root, 'fixture'), runtime = path.join(root, 'runtime')
  fs.mkdirSync(appSource)
  fs.writeFileSync(path.join(appSource, 'package.json'), JSON.stringify({ name: 'forsage-portable-probe', version: pkg.version, main: 'main.cjs' }))
  fs.writeFileSync(path.join(appSource, 'main.cjs'), `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=${JSON.stringify(root)},dist=${JSON.stringify(path.join(project, 'dist'))};
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
const write=(file,data)=>fs.writeFileSync(path.join(root,file),JSON.stringify(data));
app.on('window-all-closed',()=>{});
if(!app.requestSingleInstanceLock()){
  write('second.json',{exe:process.execPath});app.quit();
}else{
  const {loadPrintHtml}=require(path.join(dist,'print/loadPrintHtml.js'));
  const {getPrintSession}=require(path.join(dist,'print/printSession.js'));
  const {printLabelsTspl}=require(path.join(dist,'print/tsplLabelPrinter.js'));
  const {renderReceiptRaster}=require(path.join(dist,'print/receiptRaster.js'));
  const deadline=setTimeout(()=>app.exit(2),180000);let busy=false;
  const poll=setInterval(async()=>{
    if(fs.existsSync(path.join(root,'stop'))){clearInterval(poll);clearTimeout(deadline);app.quit();return}
    if(!app.isReady()||busy||!fs.existsSync(path.join(root,'render')))return;
    busy=true;
    try{
      const win=new BrowserWindow({show:false,webPreferences:{session:getPrintSession(),offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try{
        for(const count of [1,1000]){
          await loadPrintHtml(win,'<!doctype html><meta charset="utf-8">'+('<div class="label-page">ТЕСТ — 120 грн</div>'.repeat(count)));
          const actual=await win.webContents.executeJavaScript('document.querySelectorAll(".label-page").length');
          if(actual!==count)throw Error('Incomplete document');
        }
      }finally{win.destroy()}
      process.env.FORSAGE_TSPL_DRY_RUN=path.join(root,'label.tspl');
      const labels=await printLabelsTspl('<!doctype html><meta charset="utf-8"><style>body{margin:0}.label-page{width:40mm;height:25mm;font:16px Arial}</style><div class="label-page">ТЕСТ 120 грн</div>',{printerName:'POS-80',widthMm:40,heightMm:25});
      if(labels.labels!==1||labels.bytes<8000)throw Error('Empty label raster');
      const receipt=await renderReceiptRaster('<!doctype html><meta charset="utf-8"><div class="receipt-print">Форсаж<br>ТЕСТ 120 грн</div>',{widthDots:384,dpiX:203,dpiY:203});
      if(receipt.length<100)throw Error('Empty receipt raster');
      write('rendered.json',{labels:labels.labels,receiptBytes:receipt.length});
    }catch(e){write('failed.json',{message:String(e.message)})}
  },100);
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    await win.loadURL('about:blank');
    write('ready.json',{exe:process.execPath});
  }).catch(e=>{write('failed.json',{message:String(e.message)});app.exit(1)});
}
`)
  const electronRoot = path.dirname(require('electron'))
  fs.cpSync(electronRoot, runtime, { recursive: true })
  fs.renameSync(path.join(runtime, 'electron.exe'), path.join(runtime, 'ForsagePortableProbe.exe'))
  await asar.createPackage(appSource, path.join(runtime, 'resources/app.asar'))
  const output = path.join(root, 'output')
  await build({ projectDir: appSource, prepackaged: runtime, targets: Platform.WINDOWS.createTarget('portable', Arch.x64), config: {
    appId: 'ua.forsage.portable-lifecycle-probe', productName: 'ForsagePortableProbe',
    electronVersion: pkg.devDependencies.electron, directories: { output },
    compression: 'store', win: { signAndEditExecutable: false },
    portable: { ...pkg.build.portable, ...(oldWrapper ? { unpackDirName: false } : {}), artifactName: 'probe.exe' },
  } })
  const first = launch(path.join(output, 'probe.exe'))
  await until(() => fs.existsSync(path.join(root, 'ready.json')) || first.done, 'first launch')
  assert(!first.done, 'First process exited before ready: ' + first.code + (fs.existsSync(path.join(root, 'failed.json')) ? fs.readFileSync(path.join(root, 'failed.json'), 'utf8') : ''))
  const firstExe = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')).exe
  for (let attempt = 1; attempt <= 2; attempt++) {
    const second = launch(path.join(output, 'probe.exe'))
    await until(() => second.done, 'second launcher exit')
    if (second.error) throw second.error
    const secondExe = JSON.parse(fs.readFileSync(path.join(root, 'second.json'), 'utf8')).exe
    const missing = ['icudtl.dat','resources.pak','v8_context_snapshot.bin','locales/en-US.pak'].filter(file => !fs.existsSync(path.join(path.dirname(firstExe), file)))
    if (oldWrapper) {
      assert.equal(firstExe, secondExe); assert(missing.length > 0)
      console.log('REPRODUCED: second launch removed first runtime resources:', missing.join(', '))
      return
    }
    assert.notEqual(firstExe, secondExe, 'Portable launches must not share an extraction directory')
    assert.deepEqual(missing, [], 'First runtime resources were deleted')
    console.log('Repeated launch', attempt, 'preserved first process resources')
  }
  fs.writeFileSync(path.join(root, 'render'), '')
  await until(() => fs.existsSync(path.join(root, 'rendered.json')) || fs.existsSync(path.join(root, 'failed.json')), 'render after duplicate launches')
  assert(!fs.existsSync(path.join(root, 'failed.json')), fs.existsSync(path.join(root, 'failed.json')) ? fs.readFileSync(path.join(root, 'failed.json'), 'utf8') : '')
  console.log('PASS: single/1000 label layouts, TSPL dry run and receipt raster after repeated launch')
}
main().catch(error => { console.error(error); failed = true }).finally(async () => {
  fs.writeFileSync(path.join(root, 'stop'), '')
  try { await until(() => children.every(child => child.done), 'fixture shutdown', 15000) } catch { failed = true }
  if (!failed && children.every(child => child.done) && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-portable-probe-')) {
    fs.rmSync(root, { recursive: true, force: true })
  } else console.error('Only test fixture left for inspection:', root)
  process.exit(failed ? 1 : 0)
})
