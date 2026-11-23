/**
 * 23.11.2026 (план B1, слово власника): «швидке зчитування штрихкодів у вебі з телефона через камеру; мені не треба
 * відкривати картинку, увага лишається в полі вводу, моментальне зчитування».
 * Камера вмикається один раз і живе, доки її не вимкнуть; код іде туди ж, куди йде код USB-сканера:
 *  1) екран зі сканером каси (каса, товари, ревізія) отримує подію й обробляє код сам;
 *  2) інакше код лягає в поле, де стоїть курсор, і «натискається» Enter — як після USB-сканера.
 */
export const CAMERA_SCAN_EVENT = 'forsage:camera-scan'
/** Той самий код не зчитується двічі поспіль швидше за це (камера бачить його в кожному кадрі). */
export const CAMERA_REPEAT_MS = 1500

export function createScanGate(now: () => number = Date.now, repeatMs = CAMERA_REPEAT_MS) {
  let last = { code: '', at: 0 }
  return (raw: string): string | null => {
    const code = String(raw ?? '').trim()
    if (!code || code.length > 200) return null
    const at = now()
    if (code === last.code && at - last.at < repeatMs) { last = { code, at: last.at }; return null }
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
