/**
 * Retry ceiling shared by the outbox sender and pull conflict protection.
 * Failed rows at this limit are dead-letter records and no longer participate
 * in local-to-server synchronization.
 */
export const MAX_OUTBOX_ATTEMPTS = 30
