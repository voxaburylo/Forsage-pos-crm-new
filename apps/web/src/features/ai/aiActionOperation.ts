/** Stable even after a successful IPC reply followed by a renderer crash.
 * The identity is local and scoped to account/tenant; never take it from model payload.
 */
export async function aiActionOperationId(scope: string, actionId: string): Promise<string> {
  if (!scope || !actionId) throw new Error('Немає ідентифікатора підтвердженої дії. Запис не розпочато.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['ai-order-v1',scope,actionId])))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('')
}
