/**
 * 23.11.2026 (план B1, слово власника): «швидке зчитування штрихкодів у вебі з телефона через камеру; мені не треба
 * відкривати картинку, увага лишається в полі вводу, моментальне зчитування».
 * Камера вмикається один раз і живе, доки її не вимкнуть; код іде туди ж, куди йде код USB-сканера:
 *  1) екран зі сканером каси (каса, товари, ревізія) отримує подію й обробляє код сам;
 *  2) інакше код лягає в поле, де стоїть курсор, і «натискається» Enter — як після USB-сканера.
 */
export const CAMERA_SCAN_EVENT = 'forsage:camera-scan'
/**
 * Той самий код зчитується знову лише після того, як камера НЕ бачила його стільки часу (як у ручного сканера:
 * відвів — навів знову). 26.11.2026: раніше відлік ішов від першого зчитування, і код, що лишався в кадрі довше
 * за 1,5 с, зчитувався вдруге сам.
 */
export const CAMERA_REPEAT_MS = 1200

export function createScanGate(now: () => number = Date.now, repeatMs = CAMERA_REPEAT_MS) {
  let last = { code: '', at: 0 }
  return (raw: string): string | null => {
    const code = String(raw ?? '').trim()
    if (!code || code.length > 200) return null
    const at = now()
    if (code === last.code && at - last.at < repeatMs) { last = { code, at }; return null }
    last = { code, at }
    return code
  }
}

export type CameraScanOutcome = 'screen' | 'field' | 'nowhere'

type FieldLike = { tagName?: string; type?: string; readOnly?: boolean; disabled?: boolean; value?: string; dispatchEvent?: (event: Event) => boolean }

/** Поле, в яке можна «набрати» код: текстове, не лише для читання, не пароль. */
export function scanTargetField(element: unknown): FieldLike | null {
  const field = element as FieldLike | null
  const tag = String(field?.tagName ?? '').toUpperCase()
  if (!field || field.readOnly || field.disabled || typeof field.dispatchEvent !== 'function') return null
  if (tag === 'TEXTAREA') return field
  return tag === 'INPUT' && ['text', 'search', 'tel', 'number', ''].includes(String(field.type ?? '')) ? field : null
}

export function deliverCameraScan(code: string, target: Pick<Window, 'dispatchEvent' | 'document'> = window): CameraScanOutcome {
  // cancelable: екран, що сам обробив код, скасовує подію — тоді в поле нічого не друкуємо.
  const event = new CustomEvent(CAMERA_SCAN_EVENT, { detail: { code }, cancelable: true })
  if (!target.dispatchEvent(event)) return 'screen'
  const field = scanTargetField(target.document.activeElement)
  if (!field) return 'nowhere'
  // React-поля приймають зміну лише через нативний сеттер + подію input.
  const proto = Object.getPrototypeOf(field) as object | null
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined
  if (setter) setter.call(field, code); else field.value = code
  field.dispatchEvent!(new Event('input', { bubbles: true }))
  for (const type of ['keydown', 'keyup']) {
    const key = typeof KeyboardEvent === 'function' ? new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
      : Object.assign(new Event(type, { bubbles: true, cancelable: true }), { key: 'Enter', code: 'Enter' })
    field.dispatchEvent!(key)
  }
  return 'field'
}

export const CAMERA_FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'] as const

/**
 * 25.11.2026, слово власника: «я пробував, але все одно довго працює і відкривається камера; мені не треба відкривати
 * картинку». Значок камери в полях пошуку відкривав старе вікно з картинкою (повільна бібліотека, 10 кадрів/с).
 * Тепер значок лише вмикає/вимикає постійний сканер (смужка вгорі), курсор лишається в полі.
 */
export const LIVE_CAMERA_TOGGLE_EVENT = 'forsage:live-camera-toggle'
export const LIVE_CAMERA_STATE_EVENT = 'forsage:live-camera-state'
export const LIVE_CAMERA_STORAGE_KEY = 'forsage.camera-scanner'

export function toggleLiveCamera(target: Pick<Window, 'dispatchEvent'> = window): void {
  target.dispatchEvent(new CustomEvent(LIVE_CAMERA_TOGGLE_EVENT))
}

export function liveCameraStoredOn(storage: Pick<Storage, 'getItem'> | null = typeof sessionStorage === 'undefined' ? null : sessionStorage): boolean {
  try { return storage?.getItem(LIVE_CAMERA_STORAGE_KEY) === 'on' } catch { return false }
}

/**
 * 26.11.2026, слово власника: «зчитує через раз; на айфоні камера хороша, але їх три — може, вона міняє фокус; вибрати
 * одну, яка більше підходить». Камера «за замовчуванням» на iPhone — одна ширококутна: зблизька (ближче ~20 см) вона
 * не фокусується, і штрихкод розмитий. «Потрійна» чи «подвійна ширококутна» — це та сама задня камера, яка сама
 * переходить на макро зблизька; її й беремо. Назви камер телефон дає мовою системи.
 */
export function pickBackCamera(devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>): string | null {
  const back = devices.filter(device => device.kind === 'videoinput' && device.deviceId && /back|rear|задн|основн|тилов/i.test(device.label))
  const rank = (label: string) => /triple|тройн|потрійн/i.test(label) ? 3 : /dual wide|двойнS* широк|подвійнS* ширик|подвійнS* широк/i.test(label) ? 2 : /dual|двойн|подвійн/i.test(label) ? 1 : 0
  const best = back.map(device => ({ device, rank: rank(device.label) })).filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank)[0]
  return best ? best.device.deviceId : null
}
