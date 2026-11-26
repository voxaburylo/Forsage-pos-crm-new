/**
 * 23.11.2026 (план B1, слово власника): «швидке зчитування штрихкодів у вебі з телефона через камеру; мені не треба
 * відкривати картинку, увага лишається в полі вводу, моментальне зчитування».
 * Зчитаний код іде туди ж, куди йде код USB-сканера:
 *  1) екран зі сканером каси (каса, товари, ревізія) отримує подію й обробляє код сам;
 *  2) інакше код лягає в поле, де стоїть курсор (або в поле пошуку екрана), і «натискається» Enter — як після USB-сканера.
 * 26.11.2026: камера працює як «курок» ручного сканера — одне натискання, одне зчитування (див. нижче).
 */
export const CAMERA_SCAN_EVENT = 'forsage:camera-scan'

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
  // 26.11.2026: курсор не в полі — код іде в поле пошуку цього екрана (те, біля якого значок камери), а не в нікуди.
  const field = scanTargetField(target.document.activeElement) ?? scanTargetField(screenScanField(target.document))
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

/** Поле пошуку екрана, позначене data-scan-field (каса, товари, ревізія). */
export const SCAN_FIELD_ATTRIBUTE = 'data-scan-field'
function screenScanField(doc: unknown): unknown {
  const query = (doc as { querySelector?: (selector: string) => unknown } | null)?.querySelector
  try { return typeof query === 'function' ? query.call(doc, `[${SCAN_FIELD_ATTRIBUTE}]`) : null } catch { return null }
}

export const CAMERA_FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'] as const

/**
 * 26.11.2026, слово власника: «зробимо сканер ще зручнішим: біля рядка вводу штрихкоду — значок сканера, і як на
 * сканері: на ньому ж є кнопка, камера не чекає постійно й дозвіл не висить постійно. Натиснув — буквально за секунду
 * камера зчитала штрихкод, зі спалахом одночасно; щойно код зчитано — автоматично вимикається. Максимально яскраво й
 * зрозуміло».
 *
 * «Курок» сканера — значок біля поля пошуку (ScanTriggerButton):
 *  — натиснув (чи натиснув і тримаєш) — камера й ліхтарик вмикаються разом; ліхтарик заодно показує, куди дивиться камера;
 *  — код зчитано — звук, значок зеленіє, камера й ліхтарик вимикаються самі;
 *  — тримав і відпустив, не дочекавшись, — вимикається; коротке натискання чекає на код до SCAN_SESSION_MS;
 *  — натиснув ще раз під час сканування — скасував.
 * Камера більше ніде не «висить»: поза натисканням вона вимкнена.
 */
export const SCAN_TRIGGER_START_EVENT = 'forsage:scan-trigger-start'
export const SCAN_TRIGGER_STOP_EVENT = 'forsage:scan-trigger-stop'
export const SCAN_TRIGGER_STATE_EVENT = 'forsage:scan-trigger-state'
export const SCAN_TRIGGER_READ_EVENT = 'forsage:scan-trigger-read'
/** Скільки камера чекає на код після короткого натискання. */
export const SCAN_SESSION_MS = 8000
/** Довше за це — «тримаю, як курок»: відпустив — вимкнулось. */
export const SCAN_HOLD_MS = 500
/** Камера, яку вибрано минулого разу: наступне натискання просить її одразу — один запит до телефона, а не два. */
export const LIVE_CAMERA_DEVICE_KEY = 'forsage.camera-scanner.device'
export type ScanPhase = 'idle' | 'starting' | 'scanning'
export type ScanStop = 'release' | 'cancel' | 'timeout' | 'read' | 'error'

/**
 * Що робить «курок» у відповідь на дотик. Чисті правила — їх перевіряє тест без браузера.
 *  press:   нічого не сканується → почати; уже сканується → скасувати.
 *  release: якщо це натискання й почало сканування і тримали довше SCAN_HOLD_MS → вимкнути; коротке — хай чекає на код.
 */
export function triggerOnPress(phase: ScanPhase): 'start' | 'cancel' { return phase === 'idle' ? 'start' : 'cancel' }
export function triggerOnRelease(startedByThisPress: boolean, heldMs: number): 'stop' | 'keep' {
  return startedByThisPress && heldMs >= SCAN_HOLD_MS ? 'stop' : 'keep'
}

/**
 * 26.11.2026, слово власника: «зчитує через раз; на айфоні камера хороша, але їх три — може, вона міняє фокус; вибрати
 * одну, яка більше підходить». Камера «за замовчуванням» на iPhone — одна ширококутна: зблизька (ближче ~20 см) вона
 * не фокусується, і штрихкод розмитий. «Потрійна» чи «подвійна ширококутна» — це та сама задня камера, яка сама
 * переходить на макро зблизька; її й беремо. Назви камер телефон дає мовою системи.
 */
export function pickBackCamera(devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>): string | null {
  const back = devices.filter(device => device.kind === 'videoinput' && device.deviceId && /back|rear|задн|основн|тилов/i.test(device.label))
  const rank = (label: string) => /triple|тройн|потрійн/i.test(label) ? 3 : /dual wide|двойн\S* широк|подвійн\S* ширик|подвійн\S* широк/i.test(label) ? 2 : /dual|двойн|подвійн/i.test(label) ? 1 : 0
  const best = back.map(device => ({ device, rank: rank(device.label) })).filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank)[0]
  return best ? best.device.deviceId : null
}
