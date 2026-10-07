type ClipboardSource = {
  read?: () => Promise<readonly Pick<ClipboardItem, 'types' | 'getType'>[]>
  readText?: () => Promise<string>
}
export type AiClipboardContent = { text: string } | { files: File[] } | null

export class AiClipboardTimeoutError extends Error {
  constructor() {
    super('Буфер не відповів вчасно. Спробуйте Ctrl+V у полі повідомлення або виберіть файл.')
    this.name = 'AiClipboardTimeoutError'
  }
}

/** Call only from an explicit paste click. One deadline covers permission and all blob reads. */
export async function readAiClipboard(clipboard: ClipboardSource | undefined, timeoutMs = 15_000): Promise<AiClipboardContent> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<AiClipboardContent> => {
    if (clipboard?.read) {
      const items = await clipboard.read()
      const textItem = items.find(item => item.types.includes('text/plain'))
      if (textItem) return { text: await (await textItem.getType('text/plain')).text() }
      const files: File[] = []
      for (const item of items) {
        const type = item.types.find(value => value.startsWith('image/'))
        if (type) files.push(new File([await item.getType(type)], 'Фото з буфера.png', { type }))
      }
      return files.length ? { files } : null
    }
    if (clipboard?.readText) return { text: await clipboard.readText() }
    return null
  }
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AiClipboardTimeoutError()), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
