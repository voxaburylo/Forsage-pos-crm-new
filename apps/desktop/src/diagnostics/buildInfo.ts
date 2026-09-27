import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface DesktopBuildInfo {
  format: 1; version: string; builtAt: string; releaseId: string; contentHash: string;
  fileCount: number; sourceCommit: string | null; sourceDirty: boolean | null;
}

/** Optional for an old/development build; diagnostics must never stop the till. */
export function readBuildInfo(dist: string): DesktopBuildInfo | null {
  try {
    const value = JSON.parse(readFileSync(path.join(dist, 'build-info.json'), 'utf8')) as DesktopBuildInfo
    if (value.format !== 1 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(value.version)
      || !/^\d{8}T\d{6}-[a-f0-9]{12}$/.test(value.releaseId)
      || !/^[a-f0-9]{64}$/.test(value.contentHash) || !Number.isFinite(Date.parse(value.builtAt))
      || !Number.isSafeInteger(value.fileCount) || value.fileCount < 3
      || !(value.sourceCommit === null || /^[a-f0-9]{7,40}$/.test(value.sourceCommit))
      || !(value.sourceDirty === null || typeof value.sourceDirty === 'boolean')) return null
    return { format: 1, version: value.version, builtAt: value.builtAt, releaseId: value.releaseId,
      contentHash: value.contentHash, fileCount: value.fileCount, sourceCommit: value.sourceCommit, sourceDirty: value.sourceDirty }
  } catch { return null }
}
