import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LanCheckList, LanReadinessPanel } from './LanReadinessPanel'

it('offers the readiness check only when the desktop build supports it', () => {
  expect(renderToStaticMarkup(<LanReadinessPanel lan={{}} />)).toBe('')
  const html = renderToStaticMarkup(<LanReadinessPanel lan={{ diagnose: async () => ({ mode: 'hub', ready: true, checks: [], firewallCommand: '', canAllowFirewall: false }) }} />)
  expect(html).toContain('Перевірити готовність')
  expect(html).toContain('перевірка назве причину')
})

it('names each check with its state so a blocked firewall is not a silent failure', () => {
  const html = renderToStaticMarkup(<LanCheckList checks={[
    { id: 'mode', state: 'ok', title: 'Режим «Головний ПК каси» ввімкнено', detail: 'Цей ПК зберігає базу магазину.' },
    { id: 'firewall', state: 'problem', title: 'Брандмауер Windows блокує підключення', detail: 'Натисніть «Дозволити в брандмауері».' },
    { id: 'discovery', state: 'unknown', title: 'Автопошук недоступний', detail: 'Підключення за адресою.' },
  ]} />)
  expect(html).toContain('data-lan-check="firewall" data-lan-state="problem"')
  expect(html).toContain('Брандмауер Windows блокує підключення')
  expect(html).toContain('aria-label="Потрібна дія"')
  expect(html).toContain('aria-label="Гаразд"')
  expect(html).toContain('aria-label="Не вдалося перевірити"')
})
