import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 27.11.2026, слово власника: «автооновлення — з сервера» і «без інтернету — через Wi-Fi». Застосунок бере екрани з тієї ж
// адреси, що й веб (лише https), а без звʼязку відкриває копію екранів, вбудовану в застосунок одним файлом.
const root = path.resolve(__dirname, '../../..')
const config = readFileSync(path.join(root, 'mobile/capacitor.config.ts'), 'utf8')
const { inlineOfflineApp } = createRequire(import.meta.url)(path.join(root, 'mobile/scripts/inline-offline-app.cjs')) as { inlineOfflineApp: (html: string, read: (asset: string) => string) => string }

describe('phone app screens: from the server, and a one-file copy inside the app for no internet', () => {
  it('loads the screens from the web address over https; without a connection opens the built-in index.html', () => {
    const url = /SCREENS_URL = '([^']+)'/.exec(config)?.[1]
    expect(url).toBe('https://forsage-pos-crm-new-web.vercel.app')
    expect(config).toContain("server: { url: SCREENS_URL, errorPath: 'index.html' }")
  })
  it('puts the code and the styles inside index.html (the app serves no other file offline)', () => {
    const html = '<html><head><link rel="modulepreload" crossorigin href="/assets/v.js"><link rel="stylesheet" crossorigin href="/assets/s.css"></head>' +
      '<body><div id="root"></div><script type="module" crossorigin src="/assets/index-s.js"></script></body></html>'
    const files: Record<string, string> = { '/assets/index-s.js': 'const s = "</script>"; console.log(s)', '/assets/s.css': 'body{color:red}' }
    const out = inlineOfflineApp(html, asset => files[asset])
    expect(out).not.toContain('/assets/')
    expect(out).toContain('<style>body{color:red}</style>')
    expect(out).toContain('<script type="module">const s = "<\\/script>"; console.log(s)</script></body>')
    expect(out.indexOf('<div id="root">')).toBeLessThan(out.indexOf('<script type="module">'))
  })
  it('refuses to guess when the build has an unexpected shape', () => {
    expect(() => inlineOfflineApp('<html><body>s</body></html>', () => '')).toThrow('Очікувався один скрипт')
  })
})
