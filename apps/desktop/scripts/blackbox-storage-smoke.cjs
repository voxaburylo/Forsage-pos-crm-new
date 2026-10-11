// Isolated real writer failures. No Electron/shop profile, database or printer is opened.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { BlackBox } = require('../dist/diagnostics/blackBox.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-blackbox-storage-'))
const boxes = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message) {
  const deadline = Date.now() + 10000
  while (!check()) { if (Date.now() > deadline) throw new Error(message); await delay(20) }
}
async function main() {
  const unavailable = path.join(root, 'not-a-directory')
  fs.writeFileSync(unavailable, 'fixture')
  const broken = new BlackBox(unavailable); boxes.push(broken)
  // Compiled TypeScript private state is observed only by this bounded test controller.
  await until(() => broken.worker === null, 'failed writer was not detached')
  assert.doesNotThrow(() => broken.record('command-end'))
  await broken.close()

  const directory = path.join(root, 'recoverable')
  const box = new BlackBox(directory); boxes.push(box)
  const marker = path.join(directory, 'last-session.json')
  const logs = () => fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')) : []
  await until(() => fs.existsSync(marker) && logs().length === 1, 'writer did not start')
  const log = path.join(directory, logs()[0]), held = log + '.held'
  assert.equal(path.dirname(log), directory)
  fs.renameSync(log, held)
  fs.mkdirSync(log) // Actual EISDIR/access refusal, not a mocked filesystem call.
  box.record('command-end', { sequence: 1 })
  await until(() => box.pending === 0, 'failed append blocked acknowledgements')
  assert.equal(fs.statSync(log).isDirectory(), true)
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).clean, false)

  // Remove only this owned empty test directory, then restore its fixture log.
  assert.equal(path.dirname(path.resolve(log)), path.resolve(directory))
  assert.equal(fs.readdirSync(log).length, 0)
  fs.rmdirSync(log)
  fs.renameSync(held, log)
  box.record('command-end', { sequence: 2 })
  await until(() => box.pending === 0, 'recovered append was not acknowledged')
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.some(event => event.details.sequence === 1), false)
  assert.equal(events.some(event => event.details.sequence === 2), true)
  await box.close()
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).clean, true)
  await until(() => process.getActiveResourcesInfo().filter(name => name === 'MessagePort').length === 0, 'writer did not exit')
  console.log(JSON.stringify({ unavailableDirectory: 'safe', failedAppend: 'acknowledged-without-crash',
    restoredStorage: 'next-event-written', cleanClose: true, lostEventRecovered: false,
    shopDatabaseOpened: false, printerContacted: false }))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await Promise.all(boxes.map(box => box.close()))
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('forsage-blackbox-storage-')
    || fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved).toLowerCase() !== resolved.toLowerCase())
    throw new Error('Refusing unsafe fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
})
