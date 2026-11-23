#!/usr/bin/env node
/**
 * Значок програми каси з логотипу вебу (22.11.2026, слово власника: «логотип як у веб-версії всюди й іконку програми»).
 *
 *   node apps/desktop/scripts/make-icon.cjs
 *
 * Джерело — apps/desktop/build/icon.svg (той самий малюнок, що apps/web/public/favicon.svg).
 * Малює його браузером Playwright у розмірах 16…256 і складає apps/desktop/build/icon.ico (PNG усередині).
 */
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const source = path.resolve(__dirname, '../build/icon.svg')
const target = path.resolve(__dirname, '../build/icon.ico')

function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
  const entries = [], bodies = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size; entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(entry); bodies.push(png)
  }
  return Buffer.concat([header, ...entries, ...bodies])
}

;(async () => {
  const svg = fs.readFileSync(source, 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const images = []
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
      images.push({ size, png: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }) })
      await page.close()
    }
    fs.writeFileSync(target, ico(images))
    console.log('icon.ico', images.map(image => `${image.size}px ${image.png.length}B`).join(', '))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })
