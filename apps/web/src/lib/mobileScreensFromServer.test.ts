import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 27.11.2026, слово власника: «автооновлення — з сервера». Застосунок на телефоні бере екрани з тієї ж адреси, що й веб,
// і має сторінку «немає звʼязку», яка веде туди ж. Адреса — лише https (без змішаного вмісту).
const root = path.resolve(__dirname, '../../..')
const config = readFileSync(path.join(root, 'mobile/capacitor.config.ts'), 'utf8')
const offline = readFileSync(path.join(root, 'web/public/offline.html'), 'utf8')

describe('phone app screens come from the server', () => {
  it('loads the screens from the web address over https and has an offline page', () => {
    const url = /SCREENS_URL = '([^']+)'/.exec(config)?.[1]
    expect(url).toBe('https://forsage-pos-crm-new-web.vercel.app')
    expect(config).toContain("server: { url: SCREENS_URL, errorPath: 'offline.html' }")
    expect(offline).toContain(`${url}/`)
    expect(offline).toContain('Спробувати ще раз')
  })
})
