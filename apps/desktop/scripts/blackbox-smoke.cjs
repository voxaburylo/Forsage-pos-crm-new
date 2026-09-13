const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { BlackBox } = require('../dist/diagnostics/blackBox.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

if (process.argv[2] === '--crash-child') {
  const box = new BlackBox(process.argv[3])
  box.record('command-start', { channel: 'desktop:test', sequence: 1 })
  setTimeout(() => process.exit(7), 500)
} else {
  ;(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-blackbox-smoke-'))
    const events = () => fs.readdirSync(root).filter(f => f.endsWith('.jsonl')).flatMap(f =>
      fs.readFileSync(path.join(root, f), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    try {
      const child = spawnSync(process.execPath, [__filename, '--crash-child', root], { timeout: 10000, windowsHide: true })
      assert.equal(child.status, 7)
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'last-session.json'))).clean, false)
      const box = new BlackBox(root)
      box.record('command-start', { channel: 'desktop:test', sequence: 2, password: 'DO-NOT-LOG' })
      await delay(300)
      // Test-only: block THIS synthetic process while its writer worker remains alive.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 21000)
      await delay(300)
      box.record('command-end', { channel: 'desktop:test', sequence: 2, duration_ms: 21000 })
      await box.close()
      const records = events()
      assert(records.some(e => e.event === 'previous-session-unclean'))
      assert(records.some(e => e.event === 'main-heartbeat-delayed'))
      assert(records.some(e => e.event === 'main-event-loop-delay'))
      assert(records.some(e => e.event === 'command-end'))
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'last-session.json'))).clean, true)
      assert(!JSON.stringify(records).includes('DO-NOT-LOG'))
      const brokenPath = path.join(root, 'not-a-directory')
      fs.writeFileSync(brokenPath, 'test')
      const broken = new BlackBox(brokenPath)
      broken.record('command-start', {})
      await delay(100)
      await broken.close()
      console.log('Black box smoke passed: worker, abnormal exit, stalled main, privacy, clean shutdown, I/O failure')
    } finally {
      if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('forsage-blackbox-smoke-')) fs.rmSync(root, { recursive: true, force: true })
    }
  })().catch(error => { console.error(error); process.exitCode = 1 })
}
