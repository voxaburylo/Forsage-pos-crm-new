// Notifications may contain server-provided text. Only navigate inside the app.
export function notificationLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32)) return null
  try {
    const url = new URL(value, 'https://forsage.invalid')
    return url.origin === 'https://forsage.invalid' ? url.pathname + url.search + url.hash : null
  } catch { return null }
}
