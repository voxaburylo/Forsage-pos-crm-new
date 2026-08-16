const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const path = require('node:path')

const source = path.resolve(__dirname, '../../web/dist')
const target = path.resolve(__dirname, '../dist/renderer')

if (!existsSync(path.join(source, 'index.html'))) {
  throw new Error(`Web renderer is not built: ${source}`)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(path.dirname(target), { recursive: true })
cpSync(source, target, { recursive: true })

if (!existsSync(path.join(target, 'index.html'))) {
  throw new Error(`Renderer copy failed: ${target}`)
}

console.log(`Renderer embedded into ${target}`)
