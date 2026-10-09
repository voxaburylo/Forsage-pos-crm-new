const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const { verifyBuild } = require('./verify-build.cjs')

function verifyPackage(archive, project = path.resolve(__dirname, '..')) {
  // An intact old archive is not proof that the newly compiled release was packed.
  const expected = verifyBuild(path.resolve(project))
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const asar = libraryRequire('@electron/asar')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-verify-package-'))
  try {
    asar.extractAll(path.resolve(archive), temporary)
    const info = verifyBuild(temporary)
    const identity = ['version', 'releaseId', 'builtAt', 'contentHash', 'fileCount', 'sourceCommit', 'sourceDirty']
    if (identity.some(key => info[key] !== expected[key])) {
      throw new Error('Packaged release does not match the selected build: ' + info.releaseId + ' != ' + expected.releaseId)
    }
    for (const worker of ['repositories/supplyInvoiceWorker.js', 'repositories/catalogAgentWorker.js', 'repositories/syncPullWorkerEntry.js']) {
      if (!fs.existsSync(path.join(temporary, 'dist', worker))) throw new Error('Packaged worker missing: ' + worker)
    }
    return info
  } finally {
    if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('forsage-verify-package-'))
      fs.rmSync(temporary, { recursive: true, force: true })
  }
}
module.exports = { verifyPackage }
if (require.main === module) {
  const archive = process.argv[2] || path.resolve(__dirname, '../release/win-unpacked/resources/app.asar')
  const info = verifyPackage(archive, process.argv[3])
  console.log('Verified packaged release: ' + info.releaseId + ', files: ' + info.fileCount)
}
