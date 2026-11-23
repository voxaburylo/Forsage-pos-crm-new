import { useSyncExternalStore } from 'react'
import { isDesktopRuntime } from './desktopBridge'
import { remoteBridgeSlot, subscribeRemoteBridgeSlot } from './remoteDesktop/slot'

/**
 * 22.11.2026: дані йдуть у базу головного ПК — або це сама програма каси, або екран вебу, відкритий через головний ПК.
 * Для рішень «куди писати»; для всього, що стосується самого компʼютера (друк, мережа, вхід), — isDesktopRuntime().
 */
export function writesToMainPc(): boolean {
  return isDesktopRuntime() || remoteBridgeSlot() !== null
}

/**
 * Те саме для екрана: перемальовує його, коли веб підключився до головного ПК чи втратив місток (23.11.2026).
 * Кнопки змін показуємо за цим, а не за isDesktopRuntime(): інакше у вебі вони сховані навіть через головний ПК.
 */
export function useWritesToMainPc(): boolean {
  return useSyncExternalStore(subscribeRemoteBridgeSlot, writesToMainPc, () => false)
}
