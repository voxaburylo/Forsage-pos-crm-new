import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKGROUND_TASK, HANDOFF_FILE, OWNER_FILE, clearHandoff, decideStart, handoffRequested, isBackgroundLaunch, liveOwner, processAlive,
  readOwner, releaseOwner, waitForExit, writeOwner,
} from '../src/background/tillOwner'

// 22.11.2026, рішення власника: база головного ПК працює у фоні з ввімкнення ПК (ще до входу у Windows),
// а вікно каси, відкриваючись, забирає базу собі. Базу тримає лише одна копія програми.
let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-owner-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const noSleep = () => undefined

describe('who holds the database of the main PC', () => {
  it('recognises the background launch only by its flag', () => {
    expect(isBackgroundLaunch(['Forsage.exe', '--background'])).toBe(true)
    expect(isBackgroundLaunch(['Forsage.exe'])).toBe(false)
    expect(isBackgroundLaunch(['Forsage.exe', '--backgroundx'])).toBe(false)
  })

  it('records the owner and removes only its own record', () => {
    writeOwner(root, 'background', 4242, new Date('2026-11-22T20:00:00Z'))
    expect(readOwner(root)).toEqual({ pid: 4242, mode: 'background', started_at: '2026-11-22T20:00:00.000Z' })
    releaseOwner(root, 1)
    expect(readOwner(root)?.pid).toBe(4242)
    releaseOwner(root, 4242)
    expect(existsSync(path.join(root, OWNER_FILE))).toBe(false)
    writeFileSync(path.join(root, OWNER_FILE), '{broken')
    expect(readOwner(root)).toBeNull()
    writeFileSync(path.join(root, OWNER_FILE), JSON.stringify({ pid: 7, mode: 'server' }))
    expect(readOwner(root)).toBeNull()
  })

  it('a record left after a power cut (dead process) does not count', () => {
    writeOwner(root, 'window', 4242)
    expect(liveOwner(root, () => false)).toBeNull()
    expect(liveOwner(root, () => true)?.pid).toBe(4242)
    // Свій власний запис — теж не «чужий власник».
    expect(liveOwner(root, () => true, 4242)).toBeNull()
  })

  it('knows a real living and a finished process', async () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(0)).toBe(false)
    expect(processAlive(-5)).toBe(false)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'ignore' })
    expect(processAlive(child.pid!)).toBe(true)
    await new Promise(resolve => child.once('exit', resolve))
    expect(waitForExit(child.pid!, 5_000)).toBe(true)
  })

  it('waiting gives up after the time limit', () => {
    let clock = 0
    const sleep = (ms: number) => { clock += ms }
    const realNow = Date.now
    Date.now = () => 1_000_000 + clock
    try { expect(waitForExit(4242, 2_000, () => true, sleep)).toBe(false) } finally { Date.now = realNow }
    expect(clock).toBeGreaterThanOrEqual(2_000)
  })
})

describe('the window takes the database from the background, never the other way round', () => {
  it('nobody holds it: both start', () => {
    expect(decideStart(root, false, { alive: () => true })).toEqual({ action: 'start' })
    expect(decideStart(root, true, { alive: () => true })).toEqual({ action: 'start' })
  })

  it('the window asks the background to let go, waits, then starts', () => {
    writeOwner(root, 'background', 4242)
    const events: string[] = []
    let checks = 0
    const decision = decideStart(root, false, {
      // Живий, доки фон не побачив прохання; потім завершується.
      alive: pid => pid === 4242 && (checks++ < 1 || !handoffRequestedSeen()),
      sleep: noSleep,
      log: event => events.push(event),
    })
    function handoffRequestedSeen() { return events.includes('background-handoff-requested') }
    expect(decision).toEqual({ action: 'start' })
    expect(events).toEqual(['background-handoff-requested', 'background-handoff-finished'])
    // Прохання прибрано, щоб наступний фон не закрився одразу.
    expect(handoffRequested(root)).toBe(false)
  })

  it('the background never starts while a window holds the database', () => {
    writeOwner(root, 'window', 4242)
    expect(decideStart(root, true, { alive: () => true, sleep: noSleep })).toEqual({ action: 'exit', reason: 'window-owns-database' })
    writeOwner(root, 'background', 4242)
    expect(decideStart(root, true, { alive: () => true, sleep: noSleep })).toEqual({ action: 'exit', reason: 'background-already-running' })
  })

  it('the background started by a closing window waits for it to finish, then takes over', () => {
    writeOwner(root, 'window-closing', 4242)
    let alive = 3
    expect(decideStart(root, true, { alive: () => alive-- > 0, sleep: noSleep })).toEqual({ action: 'start' })
  })

  it('the handoff request is a plain file the background watches', () => {
    expect(handoffRequested(root)).toBe(false)
    writeFileSync(path.join(root, HANDOFF_FILE), '{}')
    expect(handoffRequested(root)).toBe(true)
    clearHandoff(root)
    expect(handoffRequested(root)).toBe(false)
  })
})

describe('wiring of the background mode', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')

  it('decides before any database work and before the Electron lock', () => {
    const decide = main.indexOf('decideStart(ownerDataRoot, backgroundMode)')
    expect(decide).toBeGreaterThan(0)
    expect(decide).toBeLessThan(main.indexOf('app.requestSingleInstanceLock()'))
    expect(decide).toBeLessThan(main.indexOf('openLocalDatabaseOrExplain('))
    expect(main).toContain("const gotSingleInstanceLock = startDecision.action === 'start' && app.requestSingleInstanceLock()")
  })

  it('the background opens no window, shows no dialogs and quits gracefully on request', () => {
    expect(main).toContain("if (backgroundMode) {\n    // Фон: вікна немає.")
    expect(main).toContain("if (handoffRequested(dataRoot)) { blackBox?.record('background-handoff'); app.quit() }")
    expect(main).toContain("app.on('window-all-closed', () => { if (!backgroundMode) app.quit() })")
    expect(main).toContain("if (!backgroundMode) dialog.showErrorBox('Запущено стару версію Форсажу'")
    expect(main).toContain("if (!backgroundMode) dialog.showErrorBox(\n    'Forsage не запустився'")
  })

  it('a closing window of the main PC starts the background again; a manager PC does not', () => {
    const block = main.slice(main.indexOf('// Базу відпущено.'), main.indexOf('quitAfterCleanup = true'))
    expect(block).toContain("localNetwork?.getStatus().mode !== 'client'")
    expect(block).toContain("writeOwner(ownerDataRoot, 'window-closing')")
    expect(block).toContain("['/Run', '/TN', BACKGROUND_TASK]")
    // Запуск фону — лише після того, як базу закрито.
    expect(main.indexOf('// Базу відпущено.')).toBeGreaterThan(main.indexOf('localDatabase?.close()'))
  })

  it('the setup script and the installer use the same task', () => {
    const script = readFileSync(new URL('../scripts/background-task.ps1', import.meta.url), 'utf8')
    expect(BACKGROUND_TASK).toBe('\\Forsage\\TillBackground')
    expect(script).toContain("$TaskPath = '\\Forsage\\'")
    expect(script).toContain("$TaskName = 'TillBackground'")
    expect(script).toContain("-Argument '--background'")
    expect(script).toContain('-AtStartup')
    expect(script).toContain('-MultipleInstances IgnoreNew')
    const installer = readFileSync(new URL('../scripts/install-main-till.cjs', import.meta.url), 'utf8')
    expect(installer).toContain('const backgroundTask = String.raw`\\Forsage\\TillBackground`')
    expect(installer).toContain("'till-handoff.request'")
  })
})
