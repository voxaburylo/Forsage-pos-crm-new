/** Native crash dumps remain on this PC; never attach them to cloud backups. */
export const LOCAL_CRASH_OPTIONS = {
  productName: 'Forsage',
  uploadToServer: false,
  ignoreSystemCrashHandler: false,
} as const
