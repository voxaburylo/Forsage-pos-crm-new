#!/usr/bin/env node
/**
 * Встановлення зібраного EXE на головний ПК каси (раніше — тимчасовий скрипт у %TEMP%).
 *
 *   node apps/desktop/scripts/install-main-till.cjs <sha256-нового-exe> <шлях-до-exe-ярлика> [--autostart]
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

// 22.11.2026: фоновий режим каси. Фонову копію (без вікна) закриваємо так само, як закривається вона сама,
// коли відкривають касу: просимо відпустити базу й чекаємо (не «вбиваємо» процес посеред запису).
const ownerRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Forsage')
const backgroundTask = String.raw`\Forsage\TillBackground`
let backgroundWasRunning = false
try {
  const owner = JSON.parse(require('node:fs').readFileSync(path.join(ownerRoot, 'till-owner.json'), 'utf8'))
  let alive = false
  try { process.kill(owner.pid, 0); alive = true } catch (error) { alive = error?.code === 'EPERM' }
  if (owner.mode === 'background' && alive) {
    backgroundWasRunning = true
    require('node:fs').writeFileSync(path.join(ownerRoot, 'till-handoff.request'), JSON.stringify({ from: process.pid, at: new Date().toISOString(), reason: 'install' }))
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      try { process.kill(owner.pid, 0) } catch (error) { if (error?.code !== 'EPERM') break }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
    console.log('background', 'released')
  }
} catch { /* фонового режиму немає */ }

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

// 22.11.2026: головна каса запускається з постійної теки (швидкий старт, один дозвіл брандмауера).
// Та сама збірка: тека win-unpacked, з якої electron-builder зібрав щойно встановлений portable-EXE.
const { installAppFolder } = require('./install-app-folder.cjs')
const { assertShopClosed } = require('./install-release.cjs')
const folder = installAppFolder({
  sourceDir: path.resolve(__dirname, '../release/staged/win-unpacked'),
  appDir: path.join(process.env.LOCALAPPDATA ?? '', 'Forsage/app'),
  previousDir: path.join(process.env.LOCALAPPDATA ?? '', 'Forsage/old-builds/app-before-update'),
  portableExecutable: destination,
  checkClosed: assertShopClosed,
})
console.log('folder', JSON.stringify(folder))

// Ярлик каси на робочому столі веде на постійну теку. Змінюємо лише ярлик, що вів на цей portable-EXE.
// Відкат: повернути ярлику ціль <portable-EXE> (або запустити old-builds\Forsage-before-update.exe).
const appExe = path.join(folder.appDir, 'Forsage.exe')
const shortcut = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'ФОРСАЖ — КАСА.lnk')
const ps = (script, env) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, ...env } }).trim()
const linkScript = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:FORSAGE_LNK);"
const current = ps(linkScript + '$s.TargetPath', { FORSAGE_LNK: shortcut })
if (path.resolve(current).toLowerCase() === path.resolve(appExe).toLowerCase()) console.log('shortcut', 'already', current)
else if (path.resolve(current).toLowerCase() === path.resolve(destination).toLowerCase()) {
  ps(linkScript + '$s.TargetPath=$env:FORSAGE_APP;$s.WorkingDirectory=$env:FORSAGE_DIR;$s.IconLocation=$env:FORSAGE_APP+",0";$s.Save()',
    { FORSAGE_LNK: shortcut, FORSAGE_APP: appExe, FORSAGE_DIR: folder.appDir })
  console.log('shortcut', current, '->', ps(linkScript + '$s.TargetPath', { FORSAGE_LNK: shortcut }))
} else console.log('shortcut', 'NOT CHANGED: unexpected target', current)

// 22.11.2026, «головний ПК — тимчасовий сервер магазину». З ключем --autostart програма стартує разом із Windows:
// після перезапуску чи вимкнення світла веб знову працює через ПК без того, щоб хтось прийшов і ввімкнув касу
// (зв'язок тримає сама програма й на екрані входу). Це звичайний ярлик у теці «Автозавантаження» цього користувача;
// прибрати — видалити ярлик. Windows має сам входити в обліковий запис, а ПК — вмикатися після повернення живлення
// (це налаштування Windows і BIOS; скрипт їх не чіпає).
if (process.argv.includes('--autostart')) {
  const startup = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ФОРСАЖ — КАСА.lnk')
  ps(linkScript + '$s.TargetPath=$env:FORSAGE_APP;$s.WorkingDirectory=$env:FORSAGE_DIR;$s.IconLocation=$env:FORSAGE_APP+",0";$s.Save()',
    { FORSAGE_LNK: startup, FORSAGE_APP: appExe, FORSAGE_DIR: folder.appDir })
  console.log('autostart', ps(linkScript + '$s.TargetPath', { FORSAGE_LNK: startup }))
} else console.log('autostart', 'not requested (--autostart starts Forsage together with Windows)')

// Фон працював до встановлення — запускаємо його знову вже з новою версією (якщо власник не відкриє касу раніше).
if (backgroundWasRunning) {
  try { execFileSync('schtasks.exe', ['/Run', '/TN', backgroundTask], { stdio: 'ignore', windowsHide: true }); console.log('background', 'restarted') }
  catch { console.log('background', 'NOT restarted: task missing') }
}
