/**
 * Retry ceiling shared by the outbox sender and pull conflict protection.
 * Reaching it means the operation stops retrying on the fast schedule: it is
 * shown as stuck and reported to the problem log.
 */
export const MAX_OUTBOX_ATTEMPTS = 30

/**
 * Раніше вичерпані спроби означали смерть операції: рядок назавжди випадав з
 * черги й чекав, поки хтось помітить і натисне «Повторити». Касир за чергою не
 * стежить — і не повинен, тому застрягле пробуємо знову раз на шість годин.
 *
 * Саме цього бракувало, коли на сервері виправили права: черга з 500 операцій
 * мала розсмоктатися сама, а замість того стояла мертвою.
 */
export const STUCK_OUTBOX_RETRY_MS = 6 * 60 * 60_000
