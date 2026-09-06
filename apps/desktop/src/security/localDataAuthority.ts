/** Каса та LAN працюють на одній SQLite. Хмарна копія не пише назад. */
export function assertLocalDataAuthority(channel: string): void {
  if (channel === 'desktop:sync:apply-pull-changes' || channel.startsWith('desktop:bootstrap:')
    || channel === 'desktop:catalog:upsert-product') {
    throw new Error('Завантаження серверних даних у робочу базу заборонено. '
      + 'Локальні ревізії, приходи та продажі є основними. Сервер отримує лише копію для перегляду.')
  }
}
