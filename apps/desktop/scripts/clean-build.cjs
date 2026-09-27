const fs = require('node:fs')
const path = require('node:path')

function cleanBuild(project) {
  const root = fs.realpathSync(project)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.build?.appId !== 'ua.forsage.crm' || pkg.main !== 'dist/main.js')
    throw new Error('Refusing to clean an unrelated project')
  const target = path.resolve(root, 'dist')
  if (path.dirname(target) !== root || path.basename(target) !== 'dist')
    throw new Error('Invalid build directory')
  if (!fs.existsSync(target)) return
  if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target)
    throw new Error('Refusing to clean a redirected build directory')
  // Only disposable compiler output. Never release/, data/, backups/ or userData.
  fs.rmSync(target, { recursive: true })
}
module.exports = { cleanBuild }
if (require.main === module) cleanBuild(path.resolve(__dirname, '..'))
