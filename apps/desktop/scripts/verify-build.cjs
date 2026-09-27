const fs = require('node:fs')
const path = require('node:path')
const { fingerprint } = require('./build-info.cjs')

function verifyBuild(project) {
  const dist = path.join(project, 'dist')
  const info = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'))
  const digest = fingerprint(dist, path.join(project, 'package.json'))
  if (info.format !== 1 || info.contentHash !== digest.contentHash || info.fileCount !== digest.fileCount)
    throw new Error('Build identity mismatch: rebuild the complete application before release')
  const html = fs.readFileSync(path.join(dist, 'renderer', 'index.html'), 'utf8')
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const resource = match[1].split(/[?#]/)[0]
    if (/^(?:https?:|data:|#)/.test(resource)) continue
    if (resource.startsWith('/') || resource.includes('..')) throw new Error('Renderer uses non-portable path: ' + resource)
    if (resource && !fs.existsSync(path.join(dist, 'renderer', resource))) throw new Error('Renderer asset is missing: ' + resource)
  }
  return info
}
module.exports = { verifyBuild }
if (require.main === module) {
  try {
    const info = verifyBuild(path.resolve(process.argv[2] || path.join(__dirname, '..')))
    console.log('Verified release: ' + info.releaseId + ', files: ' + info.fileCount)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
