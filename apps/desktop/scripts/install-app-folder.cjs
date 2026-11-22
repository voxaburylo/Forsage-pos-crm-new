// 22.11.2026, рішення власника «да»: головна каса запускається з постійної теки, а не з portable-EXE.
// Portable-EXE при кожному запуску розпаковував ~90 МБ у нову тимчасову теку з випадковою назвою:
// довгий старт і щоразу новий запит брандмауера Windows. Постійна тека — швидкий старт і один дозвіл.
// Portable-EXE лишається: з нього оновлюється ПК менеджера, і він — відкат.
// Без мережі, без зупинки процесів, без доступу до бази. Встановлює лише коли Форсаж закрито.
const fs = require('node:fs')
const path = require('node:path')
const { sha256 } = require('./install-release.cjs')

const PORTABLE_POINTER = 'forsage-portable.json'

function listFiles(root) {
  const out = []
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const rel = path.join(relative, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Refusing symbolic link in release folder: ' + rel)
      if (entry.isDirectory()) walk(rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

function manifest(root) {
  return Object.fromEntries(listFiles(root).filter(file => file !== PORTABLE_POINTER).map(file => [file, sha256(path.join(root, file))]))
}

function sameManifest(a, b) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

function assertReleaseFolder(directory) {
  for (const required of ['Forsage.exe', path.join('resources', 'app.asar')])
    if (!fs.existsSync(path.join(directory, required))) throw new Error('Release folder is incomplete: ' + required)
}

/**
 * Копіює зібрану теку win-unpacked у appDir через appDir.pending; попередня тека стає previousDir (відкат).
 * portableExecutable записується поруч, щоб головна каса й далі роздавала оновлення ПК менеджера.
 */
function installAppFolder({ sourceDir, appDir, previousDir, portableExecutable, checkClosed }) {
  sourceDir = path.resolve(sourceDir); appDir = path.resolve(appDir); previousDir = path.resolve(previousDir)
  assertReleaseFolder(sourceDir)
  if (!portableExecutable || !fs.existsSync(portableExecutable)) throw new Error('Portable executable for manager updates is missing')
  const expected = manifest(sourceDir)
  const pending = appDir + '.pending'
  if (fs.existsSync(pending)) throw new Error('Previous folder update exists; inspect it before retrying: ' + pending)
  checkClosed()
  if (fs.existsSync(appDir) && sameManifest(manifest(appDir), expected)) {
    fs.writeFileSync(path.join(appDir, PORTABLE_POINTER), JSON.stringify({ portableExecutable: path.resolve(portableExecutable) }))
    return { alreadyInstalled: true, appDir, files: Object.keys(expected).length, asar: expected[path.join('resources', 'app.asar')] }
  }
  fs.cpSync(sourceDir, pending, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  try {
    if (!sameManifest(manifest(pending), expected)) throw new Error('Copied release folder verification failed')
    fs.writeFileSync(path.join(pending, PORTABLE_POINTER), JSON.stringify({ portableExecutable: path.resolve(portableExecutable) }))
  } catch (error) {
    fs.rmSync(pending, { recursive: true, force: true })
    throw error
  }
  checkClosed()
  fs.mkdirSync(path.dirname(previousDir), { recursive: true })
  const hadPrevious = fs.existsSync(appDir)
  if (hadPrevious) {
    if (fs.existsSync(previousDir)) fs.rmSync(previousDir, { recursive: true, force: true })
    fs.renameSync(appDir, previousDir)
  }
  try {
    fs.renameSync(pending, appDir)
    if (!sameManifest(manifest(appDir), expected)) throw new Error('Installed release folder verification failed')
  } catch (error) {
    // Повертаємо попередню теку на місце; нову залишаємо для огляду.
    if (fs.existsSync(appDir)) fs.renameSync(appDir, pending)
    if (hadPrevious) fs.renameSync(previousDir, appDir)
    throw error
  }
  return { alreadyInstalled: false, appDir, previousDir: hadPrevious ? previousDir : null, files: Object.keys(expected).length,
    asar: expected[path.join('resources', 'app.asar')] }
}

module.exports = { installAppFolder, manifest, PORTABLE_POINTER }
