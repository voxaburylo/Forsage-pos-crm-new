const SETTINGS_ID = 'local-shop'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function plainObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
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

/**
 * Returns null when a retryable row cannot be interpreted safely. In that case
 * pull must preserve the complete local settings object until the row either
 * syncs or reaches the dead-letter retry limit.
 */
export function pendingSettingsKeys(
  payloadJsonValues: readonly (string | null | undefined)[],
): Set<string> | null {
  const keys = new Set<string>()
  for (const valueJson of payloadJsonValues) {
    if (!valueJson) return null
    try {
      const payload = JSON.parse(valueJson)
      if (!isPlainObject(payload)) return null
      for (const key of Object.keys(payload)) keys.add(key)
    } catch {
      return null
    }
  }
  return keys
}

/**
 * A queued local settings update protects only the fields contained in its
 * payload. Unrelated server fields must still be refreshed while that update
 * is waiting to sync.
 */
export function mergePulledShopSettingsPreservingPending(
  stored: unknown,
  incoming: unknown,
  pendingPayloadJsonValues: readonly (string | null | undefined)[],
): Record<string, unknown> {
  const protectedKeys = pendingSettingsKeys(pendingPayloadJsonValues)
  if (protectedKeys === null) return mergePulledShopSettings(stored, {})
  const applicableRemote = Object.fromEntries(
    Object.entries(plainObject(incoming))
      .filter(([key]) => !protectedKeys.has(key)),
  )
  return mergePulledShopSettings(stored, applicableRemote)
}
