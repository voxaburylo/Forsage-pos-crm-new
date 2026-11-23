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

/**
 * 23.11.2026 (план C7): запустити саму НОВУ програму на копії бази — в окремій тимчасовій теці, без мережі.
 * Програма відкриває копію з усіма своїми змінами схеми, перевіряє файл і звʼязки, пише результат і закривається.
 * Робочу базу не відкриває. Тимчасова тека видаляється.
 */
function runExeRehearsal({ exe, dataRoot, run = spawnSync, timeoutMs = 3 * 60_000, tmp = require('node:os').tmpdir() }) {
  const database = path.join(dataRoot, 'data', 'forsage.db')
  if (!fs.existsSync(database)) return { status: 'skipped', reason: 'бази каси на цьому ПК ще немає' }
  if (!fs.existsSync(exe)) return { status: 'failed', reason: 'нової програми не знайдено: ' + exe }
  const root = fs.mkdtempSync(path.join(tmp, 'forsage-exe-rehearsal-'))
  try {
    const data = path.join(root, 'Forsage', 'data')
    fs.mkdirSync(data, { recursive: true })
    // Каса на цей момент закрита (встановлювач уже перевірив) — файл бази з журналом копіюється цілим.
    fs.copyFileSync(database, path.join(data, 'forsage.db'))
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(database + suffix)) fs.copyFileSync(database + suffix, path.join(data, 'forsage.db' + suffix))
    const identity = path.join(dataRoot, 'database-identity.json')
    if (fs.existsSync(identity)) fs.copyFileSync(identity, path.join(root, 'Forsage', 'database-identity.json'))
    const result = run(exe, ['--rehearsal'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      env: { ...process.env, LOCALAPPDATA: root, FORSAGE_REHEARSAL_ROOT: root },
    })
    const file = path.join(root, 'rehearsal-result.json')
    if (!fs.existsSync(file)) return { status: 'failed', reason: 'нова програма не відкрила копію бази (код ' + result.status + (result.error ? ', ' + result.error.message : '') + ')' }
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    const summary = 'схема ' + report.schema_version + ', товарів ' + report.products
      + (report.findings?.length ? ', зауваження: ' + report.findings.map(item => item.title + ' (' + item.count + ')').join('; ') : '')
    if (!report.ok) return { status: 'failed', reason: 'нова програма на копії бази: ' + (report.error ?? 'помилка') , report }
    return { status: 'passed', reason: summary, report }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}

module.exports = { runInstallRehearsal, runExeRehearsal, REHEARSAL_TEST }
