#!/usr/bin/env node
/**
 * Живий смок фонового режиму каси (22.11.2026) — на ізольованій порожній базі, робочу не чіпає.
 *
 *   node apps/desktop/scripts/background-mode-smoke.cjs
 *
 * 1) Програма з ключем --background стартує без вікна, відкриває базу й записує себе власником.
 * 2) Друга фонова копія одразу виходить (базу вже тримають).
 * 3) Прохання відпустити базу — фонова копія коректно закривається й прибирає свій запис.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const desktop = path.resolve(__dirname, '..')
const electron = require(path.join(desktop, 'node_modules', 'electron'))
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-background-smoke-'))
const env = { ...process.env, LOCALAPPDATA: path.join(sandbox, 'local'), APPDATA: path.join(sandbox, 'roaming'), FORSAGE_TEST_USER_DATA: path.join(sandbox, 'profile') }
delete env.ELECTRON_RUN_AS_NODE
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true }); fs.mkdirSync(env.APPDATA, { recursive: true })
const dataRoot = path.join(env.LOCALAPPDATA, 'Forsage')
const ownerFile = path.join(dataRoot, 'till-owner.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const start = () => spawn(electron, [desktop, '--background'], { env, stdio: 'ignore', windowsHide: true })
async function until(check, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return; await sleep(250) }
  throw new Error('Не дочекались: ' + what)
}

;(async () => {
  const first = start()
  try {
    await until(() => fs.existsSync(ownerFile) && fs.existsSync(path.join(dataRoot, 'data', 'forsage.db')), 60_000, 'фонова копія відкрила базу')
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    assert.equal(owner.mode, 'background')
    assert.equal(owner.pid, first.pid)
    await sleep(3_000)
    assert.equal(alive(first.pid), true, 'фонова копія працює без вікна')

    const second = start()
    const secondCode = await new Promise(resolve => second.once('exit', resolve))
    assert.equal(alive(first.pid), true, 'друга фонова копія не зачепила першу')
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, first.pid)

    const asked = Date.now()
    fs.writeFileSync(path.join(dataRoot, 'till-handoff.request'), JSON.stringify({ from: process.pid }))
    const code = await new Promise(resolve => first.once('exit', resolve))
    const released = Date.now() - asked
    assert.equal(fs.existsSync(ownerFile), false, 'фонова копія прибрала свій запис')
    const blackbox = path.join(dataRoot, 'logs', 'blackbox')
    const events = fs.readdirSync(blackbox).flatMap(name => fs.readFileSync(path.join(blackbox, name), 'utf8').split('\n')).filter(Boolean).map(line => JSON.parse(line).event)
    for (const event of ['background-started', 'background-handoff', 'shutdown-start']) assert.ok(events.includes(event), 'у журналі є ' + event)
    console.log(JSON.stringify({ ok: true, firstPid: first.pid, secondExit: secondCode, releasedMs: released, exitCode: code, events: events.filter(e => /background|shutdown|database/.test(e)) }))
  } finally {
    if (alive(first.pid)) first.kill()
    await sleep(500)
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})().catch(error => { console.error(error); process.exit(1) })
