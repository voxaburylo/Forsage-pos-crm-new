import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  CASHALOT_DLL,
  cashalotSearchDirs,
  detectCashalotDir,
  hasCashalotDll,
  resolveCashalotDir,
  type CashalotProbe,
} from '../src/fiscal/cashalotPaths'

// Каса стоїть у магазині під іншим користувачем Windows, ніж машина розробника.
// Тому шлях до Кашалота не можна тримати прибитим — його шукаємо на місці.

const SHOP_ENV: NodeJS.ProcessEnv = {
  USERPROFILE: 'C:\\Users\\kasa',
  LOCALAPPDATA: 'C:\\Users\\kasa\\AppData\\Local',
  APPDATA: 'C:\\Users\\kasa\\AppData\\Roaming',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
}

const DEV_DIR = 'C:\\Users\\neo\\AppData\\Local\\Cashalot'
const SHOP_DIR = path.join('C:\\Users\\kasa\\AppData\\Local', 'Cashalot')

/** Проба файлової системи: перелічуємо, які папки з DLL і які просто існують. */
function probeWith(withDll: string[], dirsOnly: string[] = []): CashalotProbe {
  return {
    fileExists: (target) => withDll.some((dir) => target === path.join(dir, CASHALOT_DLL)),
    dirExists: (target) => withDll.includes(target) || dirsOnly.includes(target),
  }
}

describe('пошук папки Кашалота', () => {
  it('бере папку поточного користувача, а не профіль розробника', () => {
    const detected = detectCashalotDir(SHOP_ENV, probeWith([SHOP_DIR]))
    expect(detected).toBe(SHOP_DIR)
    expect(detected).not.toContain('neo')
  })

  it('знаходить Кашалот, встановлений у Program Files', () => {
    const installed = path.join('C:\\Program Files', 'Cashalot')
    expect(detectCashalotDir(SHOP_ENV, probeWith([installed]))).toBe(installed)
  })

  it('без встановленого Кашалота повертає типовий шлях цього профілю', () => {
    expect(detectCashalotDir(SHOP_ENV, probeWith([]))).toBe(SHOP_DIR)
  })

  it('шукає лише там, де інсталятор реально лишає програму', () => {
    const dirs = cashalotSearchDirs(SHOP_ENV)
    expect(dirs[0]).toBe(SHOP_DIR)
    expect(dirs.every((dir) => dir.startsWith('C:\\'))).toBe(true)
  })

  it('порожній профіль не валить пошук', () => {
    expect(() => cashalotSearchDirs({})).not.toThrow()
    expect(cashalotSearchDirs({}).length).toBeGreaterThan(0)
  })

  it('папку без CashalotApi64.dll за Кашалот не вважає', () => {
    const probe = probeWith([SHOP_DIR], ['D:\\Порожня'])
    expect(hasCashalotDll(SHOP_DIR, probe)).toBe(true)
    expect(hasCashalotDll('D:\\Порожня', probe)).toBe(false)
    expect(hasCashalotDll('', probe)).toBe(false)
    expect(hasCashalotDll(null, probe)).toBe(false)
  })
})

describe('лікування збереженого шляху', () => {
  it('чужий шлях із fiscal.json міняється на знайдений тут', () => {
    expect(resolveCashalotDir(DEV_DIR, SHOP_ENV, probeWith([SHOP_DIR]))).toBe(SHOP_DIR)
  })

  it('робочий шлях власника лишається недоторканим', () => {
    const manual = 'D:\\Kasa\\Cashalot'
    expect(resolveCashalotDir(manual, SHOP_ENV, probeWith([manual, SHOP_DIR]))).toBe(manual)
  })

  it('порожнє налаштування дає знайдену папку', () => {
    expect(resolveCashalotDir(null, SHOP_ENV, probeWith([SHOP_DIR]))).toBe(SHOP_DIR)
    expect(resolveCashalotDir('   ', SHOP_ENV, probeWith([SHOP_DIR]))).toBe(SHOP_DIR)
  })

  it('якщо Кашалота не видно ніде — лишаємо папку, яку вказав власник', () => {
    const notYetInstalled = 'D:\\Kasa\\Cashalot'
    const probe = probeWith([], [notYetInstalled])
    expect(resolveCashalotDir(notYetInstalled, SHOP_ENV, probe)).toBe(notYetInstalled)
  })

  it('неіснуючий чужий шлях не переживає навіть відсутність Кашалота', () => {
    expect(resolveCashalotDir(DEV_DIR, SHOP_ENV, probeWith([]))).toBe(SHOP_DIR)
  })
})
