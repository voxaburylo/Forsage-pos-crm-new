let locked = false
let unlockRevision = 0
export const DESKTOP_UNLOCK_EVENT = 'forsage:desktop-access-unlocked'
export function desktopUnlockRevision(): number { return unlockRevision }
// Call only after main accepts the password or validates the current day permission.
export function confirmDesktopUnlocked(): void {
  unlockRevision++
  setDesktopAccessLocked(false)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DESKTOP_UNLOCK_EVENT))
}
export function isDesktopAccessLocked(): boolean { return locked }
export function setDesktopAccessLocked(value: boolean): void {
  if (locked === value) return
  locked = value
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('forsage:desktop-access-changed'))
}
