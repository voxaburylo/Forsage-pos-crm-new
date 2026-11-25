import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { desktopTenantArgumentPositions, normalizeRemoteTenantArguments } from '../src/security/desktopAuthorization'

// 23.11.2026: картка боржника з телефона — «Клієнта не знайдено». Веб надсилав [id, null]: undefined у JSON стає null,
// і каса шукала клієнта магазину null. Тепер головний ПК читає null на місці магазину як «не вказано».
it('a null shop id from the web means «not given» on the main PC', () => {
  for (const channel of ['desktop:pos:get-customer', 'desktop:pos:get-customer-deposit', 'desktop:pos:list-customer-vehicles']) {
    expect(desktopTenantArgumentPositions(channel)).toEqual([1])
  }
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const executor = main.slice(main.indexOf('async function executeWebRequest('), main.indexOf('let outboxPusher'))
  expect(executor).toContain('executeLanCommand(channel, list, session)')
  // 25.11.2026: null → «не вказано» тепер робить сам executeLanCommand — для вебу й для ПК менеджера однаково.
  const lan = main.slice(main.indexOf('async function executeLanCommand('), main.indexOf('async function createWindow('))
  expect(lan).toContain('normalizeRemoteTenantArguments(channel, args)')
  expect(normalizeRemoteTenantArguments('desktop:pos:get-customer', ['c', null])).toEqual(['c', undefined])
})
