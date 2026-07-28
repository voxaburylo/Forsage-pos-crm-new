export type LabelSettingsRecord = Record<string, unknown>

export interface PrepareLabelSettingsUpdateInput {
  incoming: unknown
  incomingFallbackUpdatedAt: string
  current: unknown
  currentRowUpdatedAt?: string | null
  serverReceivedAt: string
}

export interface PreparedLabelSettingsUpdate {
  shouldApply: boolean
  normalizedIncoming: LabelSettingsRecord | null
  incomingUpdatedAt: string | null
  currentUpdatedAt: string | null
}

interface BoundedTimestamp {
  value: string | null
  wasClampedFromFuture: boolean
}

const CURRENT_TIMESTAMP_FUTURE_TOLERANCE_MS = 5 * 60_000

function asRecord(value: unknown): LabelSettingsRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as LabelSettingsRecord
    : null
}

/**
 * Converts a valid date-time value to one stable representation.
 *
 * label_settings is JSONB, therefore old installations may contain malformed
 * or missing metadata. Invalid values are ignored instead of winning a
 * last-write-wins comparison by accident.
 */
export function normalizeSyncUpdatedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

/** Keeps updated_at useful as a compare-and-swap token even for two saves in one millisecond. */
export function nextSettingsRowUpdatedAt(
  currentUpdatedAt?: string | null,
  now = new Date(),
): string {
  const nowMs = now.getTime()
  const currentMs = currentUpdatedAt ? Date.parse(currentUpdatedAt) : Number.NaN
  const nextMs = Number.isFinite(currentMs) ? Math.max(nowMs, currentMs + 1) : nowMs
  return new Date(nextMs).toISOString()
}

function boundedTimestamp(
  value: unknown,
  serverReceivedAt: string,
  futureToleranceMs: number,
): BoundedTimestamp {
  const normalized = normalizeSyncUpdatedAt(value)
  const ceiling = normalizeSyncUpdatedAt(serverReceivedAt)
  if (!normalized || !ceiling) {
    return { value: normalized, wasClampedFromFuture: false }
  }
  if (Date.parse(normalized) > Date.parse(ceiling) + futureToleranceMs) {
    return { value: ceiling, wasClampedFromFuture: true }
  }
  return { value: normalized, wasClampedFromFuture: false }
}

function labelSettingsUpdatedAt(
  settings: unknown,
  fallbackUpdatedAt: string | null | undefined,
  serverReceivedAt: string,
  futureToleranceMs: number,
): BoundedTimestamp {
  const record = asRecord(settings)
  const timestamp = normalizeSyncUpdatedAt(record?.sync_updated_at)
    ?? normalizeSyncUpdatedAt(fallbackUpdatedAt)
  return boundedTimestamp(timestamp, serverReceivedAt, futureToleranceMs)
}

/**
 * Prepares one label_settings write and decides whether it is newer than the
 * value already stored on the server.
 *
 * The incoming fallback is the offline operation creation time. This keeps an
 * old queued desktop write from replacing a newer web save even if that older
 * client did not yet know about the sync_updated_at field. Client timestamps
 * beyond the fixed server receive time are bounded and cannot lock out other
 * devices indefinitely.
 */
export function prepareLabelSettingsUpdate(
  input: PrepareLabelSettingsUpdateInput,
): PreparedLabelSettingsUpdate {
  const currentTimestamp = labelSettingsUpdatedAt(
    input.current,
    input.currentRowUpdatedAt,
    input.serverReceivedAt,
    CURRENT_TIMESTAMP_FUTURE_TOLERANCE_MS,
  )
  const incoming = asRecord(input.incoming)
  if (!incoming) {
    return {
      shouldApply: false,
      normalizedIncoming: null,
      incomingUpdatedAt: null,
      currentUpdatedAt: currentTimestamp.value,
    }
  }

  const incomingTimestamp = labelSettingsUpdatedAt(
    incoming,
    input.incomingFallbackUpdatedAt,
    input.serverReceivedAt,
    0,
  )
  const current = asRecord(input.current)
  const normalizedIncoming = incomingTimestamp.value
    ? { ...incoming, sync_updated_at: incomingTimestamp.value }
    : { ...incoming }

  const shouldApply = current === null
    || currentTimestamp.value === null
    // A timestamp beyond the server clock is not a trustworthy lock. Accept
    // the next valid write and replace it with a bounded timestamp.
    || currentTimestamp.wasClampedFromFuture
    || (
      incomingTimestamp.value !== null
      && Date.parse(incomingTimestamp.value) >= Date.parse(currentTimestamp.value)
    )

  return {
    shouldApply,
    normalizedIncoming,
    incomingUpdatedAt: incomingTimestamp.value,
    currentUpdatedAt: currentTimestamp.value,
  }
}