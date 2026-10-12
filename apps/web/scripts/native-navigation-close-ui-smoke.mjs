// Real Electron close/quit events + the real React guard. Synthetic forms only.
// No Forsage main, database, account, server, printer, or installed EXE is opened.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const ts = desktopRequire('typescript')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-native-navigation-'))
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{createHashRouter,RouterProvider}from'react-router-dom';
import{NavigationGuard,useUnsavedChanges}from'/src/hooks/useUnsavedChanges.ts';
function Draft(){const[value,setValue]=useState(''),[busy,setBusy]=useState(false);
 fixture.setValue=setValue;fixture.setBusy=setBusy;useUnsavedChanges(!!value,busy);
 return <><output id="value">{value}</output><output id="busy">{String(busy)}</output></>}
function Shell(){return <><NavigationGuard/><Draft/></>}
const router=createHashRouter([{path:'*',element:<Shell/>}]);
createRoot(document.getElementById('root')).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'),
  logLevel: 'error', optimizeDeps: { entries: [] }, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'native-close-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:native-close.tsx') return '\0' + id },
    async load(id) { if (id === '\0virtual:native-close.tsx') return transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' }) },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.headers.accept?.includes('text/html')) return next()
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script>window.fixture={accept:false,confirms:0,alerts:0};window.confirm=()=>{fixture.confirms++;return fixture.accept};window.alert=()=>fixture.alerts++;</script><script type="module" src="/@id/__x00__virtual:native-close.tsx"></script></body></html>'))
      })
    },
  }],
})

try {
  await server.listen()
  const controller = path.join(temporary, 'nativeClose.cjs')
  const code = fs.readFileSync(path.join(root, 'apps/desktop/src/nativeClose.ts'), 'utf8')
  fs.writeFileSync(controller, ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
  // Keep Electron's application discovery away from the production desktop
  // package and its default profile, even before the test module is evaluated.
  const launcher = path.join(temporary, 'main.cjs')
  fs.writeFileSync(launcher, 'require(' + JSON.stringify(path.join(root, 'apps/desktop/scripts/navigation-close-smoke.cjs')) + ')')
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => {
    // The separator prevents Electron from interpreting the fixture directory
    // as another application to launch instead of an argument to this test.
    const child = spawn(desktopRequire('electron'), [launcher, '--', server.resolvedUrls.local[0], temporary, controller], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', chunk => { out += chunk; process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { err += chunk; process.stderr.write(chunk) })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 90000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); if (timedOut) reject(new Error('Synthetic native close test timed out\n' + out + err)); else resolve({ code, out, err }) })
  })
  assert.equal(result.code, 0, result.out + '\n' + result.err)
  assert.match(result.out, /NATIVE_CLOSE_PASS/)
} finally {
  await server.close()
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('forsage-native-navigation-')) {
    try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    catch { console.warn('Temporary test profile retained for diagnosis: ' + temporary) }
  }
}
