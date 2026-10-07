import { reportLocalError } from '@/lib/localDiagnostics'
import { aiAvailabilityProblem } from './aiAvailability'
export type AiFailureStage = 'file' | 'clipboard' | 'recognition' | 'write'
function isValidationFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false
  const value = error as { name?: unknown; kind?: unknown; cause?: unknown }
  if (value.name === 'AiSupplyResponseError'
    && ['missing-table', 'invalid-part', 'conflict', 'source-mismatch'].includes(String(value.kind))) return true
  return value.cause !== error && isValidationFailure(value.cause, depth + 1)
}
/** Never forward the source exception: it can contain invoice data or server credentials. */
export function reportAiFailure(stage: AiFailureStage, error: unknown): void {
  const kind = isValidationFailure(error) ? 'validation' : aiAvailabilityProblem(error).kind
  reportLocalError(new Error('AI_OPERATION_' + stage.toUpperCase() + '_' + kind.toUpperCase()))
}
