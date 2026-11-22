import { isDesktopRuntime } from './desktopBridge'
import { remoteBridgeSlot } from './remoteDesktop/slot'

/**
 * 22.11.2026: дані йдуть у базу головного ПК — або це сама програма каси, або екран вебу, відкритий через головний ПК.
 * Для рішень «куди писати»; для всього, що стосується самого компʼютера (друк, мережа, вхід), — isDesktopRuntime().
 */
export function writesToMainPc(): boolean {
  return isDesktopRuntime() || remoteBridgeSlot() !== null
}
