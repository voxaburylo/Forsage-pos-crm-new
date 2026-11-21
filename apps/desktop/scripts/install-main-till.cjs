#!/usr/bin/env node
/**
 * Встановлення зібраного EXE на головний ПК каси (раніше — тимчасовий скрипт у %TEMP%).
 *
 *   node apps/desktop/scripts/install-main-till.cjs <sha256-нового-exe> <шлях-до-exe-ярлика>
 *
 * Джерело — apps/desktop/release/staged/Forsage-0.1.0-portable.exe цієї копії.
 * Перед заміною перевіряє, що жоден процес Forsage не запущено (каса закрита), і
 * встановлює лише штатною installRelease: відкат у %LOCALAPPDATA%\Forsage\old-builds,
 * звірка SHA-256 до і після. Нічого не робить, якщо хеш не збігається.
 */
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { installRelease, sha256 } = require('./install-release.cjs')

const [expectedHash, destination] = process.argv.slice(2)
if (!/^[0-9a-f]{64}$/.test(expectedHash ?? '') || !destination) {
  console.error('Використання: node apps/desktop/scripts/install-main-till.cjs <sha256> <шлях до EXE, на який веде ярлик каси>')
  process.exit(2)
}

function runningForsage() {
  if (process.platform !== 'win32') return []
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  return out.split(/\r?\n/).filter(line => /forsage/i.test(line))
}

const running = runningForsage()
if (running.length) {
  console.error('Каса відкрита — закрийте Forsage і повторіть. Процеси:\n' + running.join('\n'))
  process.exit(3)
}

const source = path.resolve(__dirname, '../release/staged/Forsage-0.1.0-portable.exe')
const rollback = path.join(process.env.LOCALAPPDATA ?? '', 'Forsage/old-builds/Forsage-before-update.exe')
console.log('before', sha256(destination))
const result = installRelease({ source, destination, rollback, expectedHash })
console.log('result', JSON.stringify(result))
console.log('after', sha256(destination))
console.log('rollback', sha256(rollback))
