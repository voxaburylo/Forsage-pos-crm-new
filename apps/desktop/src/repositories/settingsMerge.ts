const SETTINGS_ID = 'local-shop'

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function parseStoredSettings(valueJson: string | null | undefined): Record<string, unknown> {
  if (!valueJson) return {}
  try {
    return plainObject(JSON.parse(valueJson))
  } catch {
    return {}
  }
}

/**
 * Role-filtered pulls intentionally omit secrets and role-inaccessible fields.
 * Missing properties therefore mean "not supplied", never "erase locally".
 */
export function mergePulledShopSettings(
  stored: unknown,
  incoming: unknown,
): Record<string, unknown> {
  const current = plainObject(stored)
  const remote = Object.fromEntries(
    Object.entries(plainObject(incoming)).filter(([, value]) => value !== undefined),
  )
  const { ai_api_key_encrypted: _ignored, ...safeRemote } = remote
  return { ...current, ...safeRemote, id: SETTINGS_ID }
}
