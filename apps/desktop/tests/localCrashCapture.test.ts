import { expect, it } from 'vitest'
import { LOCAL_CRASH_OPTIONS } from '../src/diagnostics/localCrashCapture'
it('keeps native crash reports local and preserves Windows error handling', () => {
  expect(LOCAL_CRASH_OPTIONS.uploadToServer).toBe(false)
  expect(LOCAL_CRASH_OPTIONS.ignoreSystemCrashHandler).toBe(false)
  expect(LOCAL_CRASH_OPTIONS).not.toHaveProperty('submitURL')
})
