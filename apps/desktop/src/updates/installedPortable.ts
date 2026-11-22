import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 22.11.2026: головна каса запускається з постійної теки (%LOCALAPPDATA%\Forsage\app), а не з portable-EXE.
 * ПК менеджера й далі оновлюється portable-EXE тієї самої збірки — його шлях встановлення записує поруч
 * у forsage-portable.json. Запущений portable-EXE (PORTABLE_EXECUTABLE_FILE) має перевагу.
 */
export function resolvePortableExecutable(env: NodeJS.ProcessEnv, execPath: string, read = (file: string) => readFileSync(file, 'utf8')): string | undefined {
  if (env.PORTABLE_EXECUTABLE_FILE) return env.PORTABLE_EXECUTABLE_FILE
  try {
    const pointer = JSON.parse(read(path.join(path.dirname(execPath), 'forsage-portable.json'))) as { portableExecutable?: unknown }
    const file = typeof pointer.portableExecutable === 'string' ? pointer.portableExecutable : ''
    return path.isAbsolute(file) && /\.exe$/i.test(file) ? file : undefined
  } catch {
    return undefined
  }
}
