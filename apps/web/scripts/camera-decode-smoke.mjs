// 26.11.2026, слово власника: «камера зчитує через раз, дуже погано розпізнає штрихкоди».
// Справжній розпізнавач (zxing у WebAssembly, той самий модуль, що в LiveCameraScanner) на намальованому кадрі 1920×1080
// з EAN-13 різного розміру й у різних місцях. Порівнює стару схему (смуга посередині, зменшена до 960 точок) з новою
// (по черзі: середина кадру і весь кадр, обидва без зменшення). Жодної камери, мережі й живих даних.
import { createSmokeCache } from './ui-smoke-cache.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('playwright')

const entry = `
import { createZxingDetector } from '/src/lib/zxingDetector.ts'
import { CAMERA_FORMATS } from '/src/lib/cameraScan.ts'
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011']
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111']
const R = L.map(code => [...code].map(bit => bit === '1' ? '0' : '1').join(''))
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL']
function ean13(code) {
  const digits = [...code].map(Number)
  let bits = '101'
  for (let i = 1; i <= 6; i += 1) bits += (PARITY[digits[0]][i - 1] === 'L' ? L : G)[digits[i]]
  bits += '01010'
  for (let i = 7; i <= 12; i += 1) bits += R[digits[i]]
  return bits + '101'
}
function frame(code, moduleWidth, centerX, centerY) {
  const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080
  const context = canvas.getContext('2d')
  context.fillStyle = '#8a8f96'; context.fillRect(0, 0, 1920, 1080)
  const bits = ean13(code), width = (bits.length + 22) * moduleWidth, height = Math.max(40, Math.round(width * 0.45))
  const left = Math.round(centerX - width / 2), top = Math.round(centerY - height / 2)
  context.fillStyle = '#fff'; context.fillRect(left, top, width, height)
  context.fillStyle = '#000'
  ;[...bits].forEach((bit, index) => { if (bit === '1') context.fillRect(left + (index + 11) * moduleWidth, top + 6, moduleWidth, height - 12) })
  return canvas
}
function crop(source, mode) {
  const width = source.width, height = source.height
  const canvas = document.createElement('canvas'); const context = canvas.getContext('2d', { willReadFrequently: true })
  if (mode === 'old') {
    const band = Math.round(height * 0.45), scale = Math.min(1, 960 / width)
    canvas.width = Math.round(width * scale); canvas.height = Math.round(band * scale)
    context.drawImage(source, 0, Math.round((height - band) / 2), width, band, 0, 0, canvas.width, canvas.height)
  } else if (mode === 'center') {
    const cropWidth = Math.round(width * 0.8), cropHeight = Math.round(height * 0.5)
    canvas.width = cropWidth; canvas.height = cropHeight
    context.drawImage(source, Math.round((width - cropWidth) / 2), Math.round((height - cropHeight) / 2), cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  } else {
    const scale = Math.min(1, 1920 / Math.max(width, height))
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale)
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
  }
  return canvas
}
window.run = async () => {
  const detector = await createZxingDetector(CAMERA_FORMATS)
  const code = '4820147864190'
  const cases = [
    { name: 'великий, по центру', m: 4, x: 960, y: 540 },
    { name: 'середній, по центру', m: 2, x: 960, y: 540 },
    { name: 'дрібний (1 точка на штрих), по центру', m: 1, x: 960, y: 540 },
    { name: 'середній, угорі кадру', m: 2, x: 960, y: 140 },
    { name: 'середній, унизу праворуч', m: 2, x: 1600, y: 940 },
    { name: 'великий, ліворуч угорі', m: 3, x: 300, y: 180 },
  ]
  const out = []
  for (const item of cases) {
    const source = frame(code, item.m, item.x, item.y)
    const read = async mode => { const started = performance.now(); const found = await detector.detect(crop(source, mode)); return { ok: found.some(row => row.rawValue === code), ms: Math.round(performance.now() - started) } }
    const old = await read('old'), center = await read('center'), full = await read('full')
    out.push({ name: item.name, old: old.ok, now: center.ok || full.ok, ms: center.ms + full.ms })
  }
  return out
}
`
const server = await createServer({
  cacheDir: createSmokeCache(), configFile: false, root: path.join(root, 'apps/web'), logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'apps/web/src') } }, server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'camera-decode-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:camera-decode.ts') return '\0' + id },
    async load(id) { if (id === '\0virtual:camera-decode.ts') return transformWithEsbuild(entry, 'fixture.ts', { loader: 'ts' }) },
    configureServer(vite) { vite.middlewares.use('/camera-decode-test', async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml('/camera-decode-test', '<html><body><script type="module" src="/@id/__x00__virtual:camera-decode.ts"></script></body></html>'))
    }) },
  }],
})
try {
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors = []; page.on('pageerror', error => errors.push(String(error)))
    await page.goto(server.resolvedUrls.local[0] + 'camera-decode-test')
    await page.waitForFunction(() => typeof window.run === 'function', null, { timeout: 30_000 })
    const results = await page.evaluate(() => window.run())
    for (const row of results) console.log(`${row.now ? 'OK ' : 'НІ '} ${row.name}: стара схема — ${row.old ? 'читає' : 'не читає'}, нова — ${row.now ? 'читає' : 'не читає'} (${row.ms} мс на пару кадрів)`)
    assert.deepEqual(errors, [])
    // Нова схема читає все, що читала стара, і код поза серединою кадру (картинки на екрані тепер немає — прицілитись ніяк).
    for (const row of results) if (row.old) assert.ok(row.now, row.name + ': стара схема читала, нова — ні')
    for (const name of results.map(row => row.name)) {
      assert.ok(results.find(row => row.name === name)?.now, name + ': нова схема не читає')
    }
    console.log('PASS camera decode: centre at full sharpness plus the whole frame')
  } finally { await browser.close() }
} finally { await server.close() }
