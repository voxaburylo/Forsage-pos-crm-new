/**
 * 23.11.2026 (план T5): репетиція на копії бази — автоматично перед кожним встановленням.
 * Раніше її запускали вручну й могли забути. Тепер встановлювач сам проганяє дії вебу (прихід, ревізія,
 * замовлення) на КОПІЇ справжньої бази кодом тієї ж копії репозиторію, з якої зібрано EXE, і не ставить
 * нову збірку, якщо репетиція впала. Робоча база не змінюється: тест копіює файл і працює з копією.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REHEARSAL_TEST = 'tests/webRehearsalOnCopy.test.ts'

/**
 * @returns {{ status: 'passed' | 'failed' | 'skipped', reason?: string, output?: string }}
 * skipped — репетицію не було на чому чи чим виконати (нової бази ще немає, немає тесту в цій копії);
 * це не помилка встановлення, але причина друкується.
 */
function runInstallRehearsal({ repoRoot, dataRoot, run = spawnSync, exists = fs.existsSync, timeoutMs = 10 * 60_000 }) {
  const database = path.join(dataRoot, 'data', 'forsage.db')
  if (!exists(database)) return { status: 'skipped', reason: 'бази каси на цьому ПК ще немає: ' + database }
  const desktop = path.join(repoRoot, 'apps', 'desktop')
  if (!exists(path.join(desktop, REHEARSAL_TEST))) return { status: 'skipped', reason: 'у цій копії немає тесту репетиції: ' + REHEARSAL_TEST }
  // Один рядок команди: аргументи сталі, тож оболонці нема чого підставити.
  const result = run('pnpm --filter desktop exec vitest run ' + REHEARSAL_TEST, {
    cwd: repoRoot, shell: true, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
    env: { ...process.env, FORSAGE_REHEARSAL_DB: dataRoot },
  })
  const output = String(result.stdout ?? '') + String(result.stderr ?? '')
  if (result.error) return { status: 'failed', reason: 'репетицію не вдалося запустити: ' + result.error.message, output }
  if (result.status !== 0) return { status: 'failed', reason: 'репетиція на копії бази впала (код ' + result.status + ')', output }
  // «Пройшло» рахується лише тоді, коли тести справді виконались, а не були пропущені.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '')
  const passed = /Tests\s+(\d+) passed/.exec(plain)
  if (!passed || Number(passed[1]) < 1 || /\d+ skipped/.test(plain)) {
    return { status: 'failed', reason: 'репетиція нічого не перевірила (тести пропущено)', output }
  }
  return { status: 'passed', reason: passed[1] + ' перевірок', output }
}

module.exports = { runInstallRehearsal, REHEARSAL_TEST }
