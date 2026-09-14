let locked = false
export function isDesktopAccessLocked(): boolean { return locked }
export function setDesktopAccessLocked(value: boolean): void {
  if (locked === value) return
  locked = value
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('forsage:desktop-access-changed'))
}
