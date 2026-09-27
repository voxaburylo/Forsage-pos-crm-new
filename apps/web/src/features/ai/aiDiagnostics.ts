import { reportLocalError } from '@/lib/localDiagnostics'
import { aiAvailabilityProblem } from './aiAvailability'
export type AiFailureStage = 'file' | 'clipboard' | 'recognition' | 'write'
/** Never forward the source exception: it can contain invoice data or server credentials. */
export function reportAiFailure(stage: AiFailureStage, error: unknown): void {
  const kind = aiAvailabilityProblem(error).kind
  reportLocalError(new Error('AI_OPERATION_' + stage.toUpperCase() + '_' + kind.toUpperCase()))
}
