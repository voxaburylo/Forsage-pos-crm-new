/**
 * Вид запчастини за назвою (26.11.2026, слово власника: «крос-номери мають враховувати й запчастину — щоб до фільтрів
 * не підтягувались, наприклад, колодки; таке іноді буває»).
 *
 * Той самий номер у різних брендів буває в різних деталей (номер «1234» — фільтр в одного виробника й колодки в іншого),
 * а збіг ми шукаємо за номером. Тому перед тим, як показати аналог чи записати крос у картку, звіряємо вид деталі.
 * Правило обережне: відкидаємо лише тоді, коли вид ВІДОМИЙ в обох і він РІЗНИЙ. Не впізнали назву — не заважаємо.
 * Назви бувають українською й російською, тому шукаємо за коренями слів.
 */
export interface PartKind { group: string; sub: string | null }

type Rule = { group: string; test: RegExp; subs?: Array<[string, RegExp]> }

// Порядок важливий: «фільтр масляний» — фільтр, а не олива; «диск гальмівний» — гальмівний диск, а не колісний.
const RULES: Rule[] = [
  { group: 'filter', test: /ф[іи]льтр/u, subs: [
    ['cabin', /салон/u], ['air', /пов[іi]тр|воздуш/u], ['fuel', /палив|топлив/u], ['oil', /масл|олив|мастил/u],
    ['transmission', /акпп|кпп|трансм/u], ['hydraulic', /г[іи]дравл/u],
  ] },
  { group: 'brake_pads', test: /колодк/u },
  { group: 'brake_disc', test: /диск\S*\s+(гальм|тормоз)|(гальм\S*|тормоз\S*)\s+диск/u },
  { group: 'brake_drum', test: /барабан/u },
  { group: 'brake_hose', test: /шланг\S*\s+(гальм|тормоз)|(гальм\S*|тормоз\S*)\s+шланг/u },
  { group: 'plug', test: /св[іе]ч/u, subs: [['glow', /розжар|накал/u], ['spark', /запал|зажиг/u]] },
  { group: 'belt', test: /рем[іе]н|ремен/u },
  { group: 'bearing', test: /п[іо]дшипник/u },
  { group: 'shock', test: /амортизатор/u },
  { group: 'wiper', test: /дв[іо]рник|склоочис|стеклоочист/u },
  { group: 'lamp', test: /ламп/u },
  { group: 'battery', test: /ак(к)?умулятор|(?<!\p{L})акб(?!\p{L})/u },
  { group: 'thermostat', test: /термостат/u },
  { group: 'pump', test: /насос|помпа/u },
  { group: 'spring', test: /пружин/u },
  { group: 'ball_joint', test: /кульов|шаров/u },
  { group: 'stabilizer', test: /стаб[іи]л[іи]затор/u },
  { group: 'tie_rod', test: /наконечник|рульов\S*\s+тяг|рулев\S*\s+тяг/u },
  { group: 'hub', test: /маточин|ступиц/u },
  { group: 'clutch', test: /зчеплен|сцеплен/u },
  { group: 'radiator', test: /рад[іи]атор/u },
  { group: 'sensor', test: /датчик/u },
  { group: 'gasket', test: /прокладк/u },
  { group: 'silent_block', test: /сайлентблок|сайлент-блок/u },
  { group: 'cv_joint', test: /шрус|шркш/u },
  { group: 'boot', test: /пильник|пыльник/u },
  { group: 'antifreeze', test: /антифриз|тосол/u },
  { group: 'oil', test: /(?<!\p{L})(олива|оливи|масло|масла|мастило)(?!\p{L})/u },
]

export function partKind(name: unknown): PartKind | null {
  const text = String(name ?? '').toLocaleLowerCase('uk-UA').replace(/[ʼ'`’]/g, '')
  if (!text.trim()) return null
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue
    const sub = rule.subs?.find(([, pattern]) => pattern.test(text))?.[0] ?? null
    return { group: rule.group, sub }
  }
  return null
}

/** true — це напевно різні деталі (вид відомий в обох і не збігається). Невідомий вид не вважається конфліктом. */
export function kindsConflict(a: PartKind | null, b: PartKind | null): boolean {
  if (!a || !b) return false
  if (a.group !== b.group) return true
  return Boolean(a.sub && b.sub && a.sub !== b.sub)
}

export const namesConflict = (a: unknown, b: unknown) => kindsConflict(partKind(a), partKind(b))

/**
 * Копія правил із server/src/services/partKind.ts (каса не тягне код сервера); однаковість стереже
 * apps/desktop/tests/partKind.test.ts. «Аналоги» на касі зводять картки за номером — відкидаємо ті, що напевно іншого виду.
 */
export function dropOtherKinds<T extends { name: string }>(sourceName: string, products: T[]): T[] {
  return products.filter(product => !namesConflict(sourceName, product.name))
}
