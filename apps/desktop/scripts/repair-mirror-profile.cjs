// Explicit repair of a legacy provisioning profile. Never rotates the public key.
// Plaintext key travels only through private child-process pipes, never a file/log/argument.
const fs = require('node:fs')
const path = require('node:path')
const { createPublicKey, sign, verify } = require('node:crypto')
if (process.versions.electron) {
  const { app, safeStorage } = require('electron')
  app.setPath('userData', process.argv[3])
  const requestReady = new Promise(resolve => process.once('message', resolve))
  let stage = 'ready'
  app.whenReady().then(async () => {
    stage = 'read-input'
    const request = await requestReady
    stage = 'decrypt'
    const pem = request.mode === 'decrypt'
      ? safeStorage.decryptString(Buffer.from(request.encrypted, 'base64')) : request.pem
    stage = 'validate-key'
    const publicKey = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()
    if (publicKey !== request.publicKey) throw Error('Identity mismatch')
    stage = 'encrypt'
    const result = request.mode === 'decrypt' ? { pem } : {
      encrypted: safeStorage.encryptString(pem).toString('base64'),
      signature: sign(null, Buffer.from('mirror-profile-repair'), pem).toString('base64'),
    }
    if (result.encrypted && safeStorage.decryptString(Buffer.from(result.encrypted, 'base64')) !== pem) throw Error('Round trip failed')
    process.send(result, () => app.exit(0))
  }).catch(() => { process.stderr.write('Protected key operation failed: ' + stage); app.exit(1) })
} else {
  const { fork } = require('node:child_process')
  async function repair() {
  const root = process.argv[2]
  const source = process.argv[3]
  const target = process.argv[4]
  if (![root, source, target].every(p => p && path.isAbsolute(p) && fs.statSync(p).isDirectory())) throw Error('Expected three existing absolute directories: data root, old profile, current profile')
  if (path.resolve(source) === path.resolve(target)) throw Error('Profiles must differ')
  const file = path.join(root, 'mirror-identity.json')
  const original = fs.readFileSync(file, 'utf8')
  const identity = JSON.parse(original)
  const run = (profile, request) => new Promise((resolve, reject) => {
    const child = fork(__filename, ['--worker', profile], {
      execPath: require('electron'), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    })
    let received = false
    const timer = setTimeout(() => { child.kill(); reject(Error('Key operation timed out')) }, 15000)
    child.once('message', result => { received = true; clearTimeout(timer); resolve(result) })
    child.once('error', () => { clearTimeout(timer); reject(Error('Protected key helper failed')) })
    child.once('exit', code => { clearTimeout(timer); if (code !== 0 || !received) reject(Error('Protected key operation failed; original identity unchanged')) })
    child.send(request)
  })
  const { pem } = await run(source, { mode: 'decrypt', encrypted: identity.encrypted_private_key, publicKey: identity.public_key })
  const next = await run(target, { mode: 'encrypt', pem, publicKey: identity.public_key })
  if (!verify(null, Buffer.from('mirror-profile-repair'), identity.public_key, Buffer.from(next.signature, 'base64'))) throw Error('Signature check failed')
  const check = await run(target, { mode: 'decrypt', encrypted: next.encrypted, publicKey: identity.public_key })
  if (check.pem !== pem || fs.readFileSync(file, 'utf8') !== original) throw Error('Identity changed during repair')
  const backup = file + '.before-profile-repair-' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  const temporary = file + '.repair-tmp'
  fs.writeFileSync(temporary, JSON.stringify({ ...identity, encrypted_private_key: next.encrypted }), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, file)
  console.log(JSON.stringify({ repaired: true, samePublicKey: true, signatureVerified: true, encryptedBackup: backup }))
  }
  repair().catch(error => { console.error(error.message); process.exitCode = 1 })
}
