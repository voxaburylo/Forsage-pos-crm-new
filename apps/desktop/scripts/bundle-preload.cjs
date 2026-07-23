// Sandboxed Electron preload scripts can only `require('electron')` and Node
// builtins — a relative `require('./ipcError')` fails at runtime with
// "module not found". So after tsc compiles the sources, bundle preload.ts
// (and everything it imports) into a single self-contained dist/preload.js.
const path = require('node:path')
const esbuild = require(path.resolve(__dirname, '../../../node_modules/esbuild'))

const projectDir = path.resolve(__dirname, '..')

esbuild
  .build({
    entryPoints: [path.join(projectDir, 'src', 'preload.ts')],
    outfile: path.join(projectDir, 'dist', 'preload.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'info',
  })
  .catch((err) => {
    console.error('preload bundle failed:', err)
    process.exit(1)
  })
