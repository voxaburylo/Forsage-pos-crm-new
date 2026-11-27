'use strict'
/**
 * 27.11.2026: запасна копія екранів для телефона без інтернету — один файл index.html.
 * Застосунок бере екрани з сервера; коли сервера не видно, Capacitor показує сторінку errorPath із самого застосунку,
 * але решту файлів (assets/*.js, *.css) за тією ж адресою вже не віддає. Тому скрипт вбудовує код і стилі в index.html.
 * Нічого не вгадує: немає рівно одного скрипта чи стилю — збірка падає з поясненням.
 */
const fs = require('node:fs')
const path = require('node:path')

function inlineOfflineApp(html, readAsset) {
  const scripts = [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)]
  const styles = [...html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)]
  if (scripts.length !== 1) throw new Error('Очікувався один скрипт у index.html, знайдено ' + scripts.length)
  if (styles.length > 1) throw new Error('Очікувався один файл стилів, знайдено ' + styles.length)
  // Рядок «</script» усередині коду закрив би тег раніше часу — у JS «<\/script» означає те саме.
  const code = readAsset(scripts[0][1]).split('</script').join('<\\/script')
  let out = html.replace(scripts[0][0], () => '')
  for (const style of styles) out = out.replace(style[0], () => '<style>' + readAsset(style[1]).split('</style').join('<\\/style') + '</style>')
  out = out.replace(/<link rel="modulepreload"[^>]*>/g, '')
  // Скрипт — у кінці body, щоб розмітка вже була на місці (type=module і так виконується після розбору).
  return out.replace('</body>', () => '<script type="module">' + code + '</script></body>')
}

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || path.join(__dirname, '../../web/dist-mobile'))
  const file = path.join(dist, 'index.html')
  const html = inlineOfflineApp(fs.readFileSync(file, 'utf8'), asset => fs.readFileSync(path.join(dist, asset.replace(/^\//, '')), 'utf8'))
  fs.writeFileSync(file, html)
  console.log('offline app: ' + file + ' (' + Math.round(Buffer.byteLength(html) / 1024) + ' KB)')
}

module.exports = { inlineOfflineApp }
