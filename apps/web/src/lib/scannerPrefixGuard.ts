/**
 * 23.11.2026: сканер магазину шле F7 перед КОЖНИМ кодом. У Chrome й Edge F7 відкриває вікно «Увімкнути режим
 * каретки?» — воно забирає фокус, і в поле потрапляє одна цифра коду (власник: «у Chrome вводить, у стандартному
 * браузері Windows — одну цифру»). F7 глушив лише сканер каси (каса, товари, ревізія); на решті екранів
 * (прихід, замовлення…) — ні. Тепер F7 глушиться в усьому застосунку. Подія далі йде до слухачів (сканер каси
 * використовує F7 як ознаку «далі код»), лише браузер не відкриває свого вікна. У програмі F7 ні для чого не потрібна.
 */
export function isScannerPrefixKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): boolean {
  return event.key === 'F7' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

export function installScannerPrefixGuard(target: Pick<Window, 'addEventListener'> = window): void {
  // Capture і найперший слухач: браузер дивиться на preventDefault, а не на те, хто першим отримав подію.
  target.addEventListener('keydown', event => { if (isScannerPrefixKey(event as KeyboardEvent)) event.preventDefault() }, { capture: true })
}
