// Real browser image decoding only: no external network, OCR calls, accounts or shop database.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { createSmokeCache } from './ui-smoke-cache.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const server = await createServer({
  configFile: false, root: path.join(root, 'apps/web'), cacheDir: createSmokeCache(), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'image-test-fixture',
    configureServer(server) {
      server.middlewares.use('/image-test', async (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(await server.transformIndexHtml('/image-test', '<html><body><script type="module">import {prepareImageDataUrl} from "/src/lib/prepareImage.ts";window.prepare=prepareImageDataUrl;</script></body></html>'))
      })
    },
  }],
})
// Insert an EXIF orientation tag into a generated JPEG (both valid TIFF byte orders).
function withOrientation(jpeg, orientation, littleEndian) {
  const segment = Buffer.alloc(36)
  segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(34, 2)
  segment.write('Exif\0\0', 4, 'ascii')
  const tiff = new DataView(segment.buffer, segment.byteOffset + 10, 26)
  tiff.setUint16(0, littleEndian ? 0x4949 : 0x4d4d)
  tiff.setUint16(2, 42, littleEndian); tiff.setUint32(4, 8, littleEndian)
  tiff.setUint16(8, 1, littleEndian); tiff.setUint16(10, 0x0112, littleEndian)
  tiff.setUint16(12, 3, littleEndian); tiff.setUint32(14, 1, littleEndian)
  tiff.setUint16(18, orientation, littleEndian)
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]).toString('base64')
}
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(), errors = [], blocked = []
  const base = server.resolvedUrls.local[0]
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
    ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  await page.goto(base + 'image-test')
  await page.waitForFunction(() => typeof window.prepare === 'function')
  const raw = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 48
    const ctx = canvas.getContext('2d')
    for (const [color,x,y] of [['#ff0000',0,0],['#00ff00',40,0],['#0000ff',0,24],['#ffff00',40,24]]) {
      ctx.fillStyle = color; ctx.fillRect(x, y, 40, 24)
    }
    return canvas.toDataURL('image/jpeg', 1).split(',')[1]
  })
  const jpeg = Buffer.from(raw, 'base64')
  const order = [
    [0,1,2,3], [1,0,3,2], [3,2,1,0], [2,3,0,1],
    [0,2,1,3], [2,0,3,1], [3,1,2,0], [1,3,0,2],
  ]
  for (const littleEndian of [true, false]) for (let orientation = 1; orientation <= 8; orientation++) {
    const result = await page.evaluate(async base64 => {
      const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/jpeg' })
      const url = await window.prepare(blob), image = new Image()
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url })
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      const palette = [[255,0,0],[0,255,0],[0,0,255],[255,255,0]]
      const corners = [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y]) => {
        const data = ctx.getImageData(Math.floor(x*canvas.width), Math.floor(y*canvas.height), 1, 1).data
        const distances = palette.map(rgb => rgb.reduce((sum,v,i) => sum + (v-data[i])**2, 0))
        return distances.indexOf(Math.min(...distances))
      })
      return { size: [canvas.width, canvas.height], corners, jpeg: url.startsWith('data:image/jpeg;base64,') }
    }, withOrientation(jpeg, orientation, littleEndian))
    assert.deepEqual(result.size, orientation < 5 ? [80,48] : [48,80], 'EXIF dimensions ' + orientation)
    assert.deepEqual(result.corners, order[orientation-1], 'EXIF pixels ' + orientation)
    assert.equal(result.jpeg, true)
  }
  const extra = await page.evaluate(async () => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL, active = new Set()
    URL.createObjectURL = blob => { const url = create(blob); active.add(url); return url }
    URL.revokeObjectURL = url => { active.delete(url); revoke(url) }
    try {
      const sizes = []
      for (const [width, height, options] of [[4000,3000,{}],[3600,2400,{maxDimension:1600,quality:.82}],[16,16,{}]]) {
        const source = document.createElement('canvas'); source.width = width; source.height = height
        const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
        const url = await window.prepare(blob, options), image = new Image()
        await new Promise((resolve, reject) => { image.onload=resolve; image.onerror=reject; image.src=url })
        const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight
        const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0)
        sizes.push({ size:[canvas.width,canvas.height], pixel:[...ctx.getImageData(0,0,1,1).data] })
      }
      let malformed=''
      try { await window.prepare(new Blob(['not an image'],{type:'image/jpeg'})) } catch(error) { malformed=error.message }
      return { sizes, malformed, active:active.size }
    } finally { URL.createObjectURL=create; URL.revokeObjectURL=revoke }
  })
  assert.deepEqual(extra.sizes.map(s=>s.size), [[1800,1350],[1600,1067],[16,16]])
  assert.ok(extra.sizes.every(s=>s.pixel.every(channel=>channel===255)))
  assert.match(extra.malformed, /прочитати фото/)
  assert.equal(extra.active, 0)
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log('PASS: 16 EXIF transforms (8 orientations x 2 byte orders), real JPEG pixels/dimensions; invoice/VIN resizing, white transparent PNG, no enlargement, decode failure and object URL cleanup. No live OCR or DB.')
} finally { await browser?.close(); await server.close() }
