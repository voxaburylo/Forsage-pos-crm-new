/**
 * 22.11.2026: у вебі той самий місток, що й у програмі каси (apps/desktop/src/preload.ts), але кожен виклик
 * іде не в локальну базу, а через сервер на головний ПК. Цей файл підміняє модуль 'electron' лише для
 * збірки вебу (alias у vite.config.ts): preload «виставляє» API сюди, а не у window.
 */
type Invoke = (channel: string, args: unknown[]) => Promise<unknown>
let exposed: unknown = null
let invokeRemote: Invoke = async () => { throw new Error('Головний ПК не на зв\'язку') }

export function setRemoteInvoke(invoke: Invoke): void { invokeRemote = invoke }
export function takeExposedBridge(): unknown { return exposed }

export const contextBridge = {
  exposeInMainWorld(_name: string, api: unknown): void { exposed = api },
}
export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => invokeRemote(channel, args),
  // Діагностика й події вікна стосуються лише самої каси — у вебі їх немає.
  send: (): void => undefined,
  on: (): void => undefined,
}
export default { contextBridge, ipcRenderer }
