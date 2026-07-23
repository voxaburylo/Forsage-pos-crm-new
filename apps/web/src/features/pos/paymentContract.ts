export async function runPaymentConfirmation(
  confirm: () => Promise<boolean>,
  onCompleted: () => void,
): Promise<boolean> {
  const completed = await confirm()
  if (!completed) return false

  onCompleted()
  return true
}

export function canUseIntegratedTerminal(
  isDesktop: boolean,
  enabled: boolean,
  provider: string | null | undefined,
): boolean {
  return !isDesktop && enabled && (provider ?? 'manual') !== 'manual'
}
