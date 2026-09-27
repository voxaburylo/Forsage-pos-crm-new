const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

function compiledFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const name = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error('Build files must not contain symbolic links')
    if (name === 'build-info.json') return []
    if (entry.isDirectory()) return compiledFiles(path.join(directory, entry.name), name + '/')
    return entry.isFile() ? [name] : []
  })
}

function fingerprint(dist, packagePath) {
  const hash = createHash('sha256')
  const files = compiledFiles(dist)
  if (!files.includes('main.js') || !files.includes('preload.js') || !files.includes('renderer/index.html'))
    throw new Error('Build incomplete: main, preload and embedded renderer are required')
  for (const name of files) {
    const content = fs.readFileSync(path.join(dist, name))
    hash.update(name + '\0' + content.length + '\0').update(content)
  }
  // electron-builder strips scripts/devDependencies and rewrites formatting.
  // Hash the runtime contract, not packaging-only whitespace or development tools.
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies || {}).sort(([a], [b]) => a.localeCompare(b, 'en')))
  hash.update('package.json\0').update(JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, dependencies }))
  return { contentHash: hash.digest('hex'), fileCount: files.length }
}

function writeBuildInfo(project, now = new Date()) {
  const dist = path.join(project, 'dist'), packagePath = path.join(project, 'package.json')
  const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
  const digest = fingerprint(dist, packagePath)
  let sourceCommit = null, sourceDirty = null
  try {
    sourceCommit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: project, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', '../../apps', '../../shared', '../../server', '../../api'], { cwd: project, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).trim())
  } catch { /* A source archive has no git metadata; do not invent a revision. */ }
  const builtAt = now.toISOString()
  const info = { format: 1, version, builtAt, releaseId: builtAt.replace(/[-:.]/g, '').slice(0, 15) + '-' + digest.contentHash.slice(0, 12),
    ...digest, sourceCommit, sourceDirty }
  fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(info, null, 2) + '\n')
  return info
}

module.exports = { compiledFiles, fingerprint, writeBuildInfo }
if (require.main === module) {
  const info = writeBuildInfo(path.resolve(__dirname, '..'))
  console.log('Release identity: ' + info.releaseId + ', files: ' + info.fileCount)
}
