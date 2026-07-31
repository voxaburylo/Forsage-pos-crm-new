export const MAX_SYNC_MONEY = 2_147_483_647

export function checkedSyncMoney(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} має містити коректну невід’ємну суму`)
  }
  const rounded = Math.round(parsed)
  if (rounded > MAX_SYNC_MONEY) {
    throw new Error(`${label} надто велика. Перевірте, чи штрихкод випадково не потрапив у поле ціни.`)
  }
  return rounded
}
