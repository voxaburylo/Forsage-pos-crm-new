import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { REHEARSAL_RESULT_FILE, rehearsalRootFrom, runStartupRehearsal } from '../src/diagnostics/startupRehearsal'

const require = createRequire(import.meta.url)
const { runExeRehearsal } = require('../scripts/install-rehearsal.cjs')

// 23.11.2026 (план C7): нова програма перед встановленням запускається на копії бази, без мережі.
describe('update rehearsal: the new program on a copy of the database', () => {
  const roots: string[] = []
  const temp = () => { const root = mkdtempSync(path.join(tmpdir(), 'forsage-c7-')); roots.push(root); return root }
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it('turns on only with the flag, the folder and LOCALAPPDATA pointing to the same place', () => {
    const root = path.resolve(tmpdir(), 'r1')
    expect(rehearsalRootFrom(['x', '--rehearsal'], { FORSAGE_REHEARSAL_ROOT: root, LOCALAPPDATA: root })).toBe(root)
    expect(rehearsalRootFrom(['x'], { FORSAGE_REHEARSAL_ROOT: root, LOCALAPPDATA: root })).toBeNull()
    // Робоча тека каси (LOCALAPPDATA справжній) — режим не вмикається, щоб не торкнутись робочої бази.
    expect(rehearsalRootFrom(['x', '--rehearsal'], { FORSAGE_REHEARSAL_ROOT: root, LOCALAPPDATA: 'C:\\Users\\neo\\AppData\\Local' })).toBeNull()
    expect(rehearsalRootFrom(['x', '--rehearsal'], { FORSAGE_REHEARSAL_ROOT: 'relative', LOCALAPPDATA: 'relative' })).toBeNull()
  })

  it('opens the copy with its own schema changes, checks it and writes the result', () => {
    const root = temp()
    const seed = new LocalDatabase(path.join(root, 'Forsage')); seed.close()
    const result = runStartupRehearsal(root, 'rel-1')
    expect(result).toMatchObject({ ok: true, release_id: 'rel-1', products: 0, error: null })
    expect(result.schema_version).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(path.join(root, REHEARSAL_RESULT_FILE), 'utf8'))).toEqual(result)
  })

  it('a copy that cannot be opened fails the rehearsal', () => {
    const root = temp()
    mkdirSync(path.join(root, 'Forsage', 'data'), { recursive: true })
    mkdirSync(path.join(root, 'Forsage', 'backups'), { recursive: true })
    // Порожній файл бази там, де вже були дані магазину, — програма не має права «почати з нуля».
    require('node:fs').writeFileSync(path.join(root, 'Forsage', 'database-identity.json'), '{}')
    require('node:fs').writeFileSync(path.join(root, 'Forsage', 'data', 'forsage.db'), '')
    expect(runStartupRehearsal(root, null)).toMatchObject({ ok: false })
  })

  it('the installer runs the new EXE on a copy in a temporary folder and deletes it afterwards', () => {
    const shop = temp()
    const seed = new LocalDatabase(shop); seed.close()
    let seen: { args: string[]; env: Record<string, string> } | null = null
    const run = vi.fn((_exe: string, args: string[], options: { env: Record<string, string> }) => {
      seen = { args, env: options.env }
      // Справжня програма в режимі репетиції робить саме це.
      runStartupRehearsal(options.env.FORSAGE_REHEARSAL_ROOT, 'new-build')
      return { status: 0 }
    })
    const outcome = runExeRehearsal({ exe: process.execPath, dataRoot: shop, run })
    expect(outcome.status).toBe('passed')
    expect(outcome.reason).toContain('товарів 0')
    expect(seen!.args).toEqual(['--rehearsal'])
    expect(seen!.env.LOCALAPPDATA).toBe(seen!.env.FORSAGE_REHEARSAL_ROOT)
    expect(seen!.env.LOCALAPPDATA).not.toBe(path.dirname(shop))
    expect(existsSync(seen!.env.FORSAGE_REHEARSAL_ROOT)).toBe(false)
  })

  it('no result from the new program means do not install', () => {
    const shop = temp()
    const seed = new LocalDatabase(shop); seed.close()
    expect(runExeRehearsal({ exe: process.execPath, dataRoot: shop, run: () => ({ status: 3 }) })).toMatchObject({ status: 'failed' })
  })

  it('the installer stops when the new program fails on the copy, and the main process starts nothing else in rehearsal', () => {
    const installer = readFileSync(new URL('../scripts/install-main-till.cjs', import.meta.url), 'utf8')
    expect(installer).toContain("const started = runExeRehearsal({ exe: source, dataRoot: ownerRoot })")
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("globalThis.fetch = (async () => { throw new Error('REHEARSAL_OFFLINE') }) as typeof fetch")
    expect(main).toMatch(/if \(rehearsalRoot\) \{\n\s+\/\/ Нічого іншого не запускаємо[^\n]*\n\s+const outcome = runStartupRehearsal\(rehearsalRoot/)
  })
})
